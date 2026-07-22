-- ---------------------------------------------------------------------------
-- 0072 — suki discount cards (loyalty discount at POS)
--
-- Gerwin produces and prints a physical card for a loyal customer; the cashier
-- scans it during Record Sale and a discount applies automatically:
-- suki_engine_discount_pct off engines, suki_part_discount_pct off parts
-- (Settings dials, default 10 / 5 — rates are DATA, never code).
--
-- Three rules keep this safe:
--   • NEVER trust a client price. fn_record_sale re-derives each line's card
--     price server-side (settings rate + server-read cost) and CLAMPS the
--     client's agreed price to it — the suki always gets at least the card
--     rate (can negotiate LOWER, never higher), and the 0053 strict > cost
--     floor still holds: the card price is capped at cost+1 on thin margins.
--   • COST STAYS OWNER-ONLY. discount_cards is an owner-only table; shops
--     resolve a scanned card ONLY through fn_lookup_discount_card, a guarded
--     definer that returns the customer + the two percentages and nothing
--     else (the fn_shop_warranty_preview pattern). No card browsing.
--   • THE DISCOUNT LIVES IN THE PRICE. Revenue is the discounted total, COGS
--     freezes at approval as always — P&L needs no special case.
--     sales.card_discount_centavos exists for suki-program reporting only.
--
-- Card numbers are minted 'SC' + 8 digits from their own sequence — a prefix
-- distinct from product barcodes ('GT', 0062) so a card scanned into the
-- product field is unambiguous and can never collide with a product.
--
-- One ACTIVE card per customer (partial unique index); a lost card is
-- deactivated and reissued as a new row, so history stays.
-- ---------------------------------------------------------------------------

-- ── 1. Settings dials ───────────────────────────────────────────────────────
alter table public.settings
  add column if not exists suki_engine_discount_pct int not null default 10
    check (suki_engine_discount_pct between 0 and 100),
  add column if not exists suki_part_discount_pct int not null default 5
    check (suki_part_discount_pct between 0 and 100);

comment on column public.settings.suki_engine_discount_pct is
  'Suki card discount on engine lines, percent off the catalog price. Applied
   server-side in fn_record_sale, capped so the price stays strictly above cost.';
comment on column public.settings.suki_part_discount_pct is
  'Suki card discount on part lines, percent off the catalog price. Same rules.';

-- ── 2. discount_cards ───────────────────────────────────────────────────────
create sequence if not exists public.discount_card_seq;

create table if not exists public.discount_cards (
  id uuid primary key default gen_random_uuid(),
  card_no text not null unique,
  customer_id uuid not null references public.customers(id),
  status text not null default 'active' check (status in ('active','inactive')),
  issued_by uuid references public.profiles(id),
  issued_at timestamptz not null default now(),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

comment on table public.discount_cards is
  'Suki loyalty cards. Owner-only; shops resolve a scanned card via
   fn_lookup_discount_card. One active card per customer; reissue = deactivate
   + new row.';

create unique index if not exists discount_cards_one_active_per_customer
  on public.discount_cards (customer_id)
  where status = 'active' and deleted_at is null;

create index if not exists idx_discount_cards_customer
  on public.discount_cards (customer_id);

alter table public.discount_cards enable row level security;
revoke all on public.discount_cards from anon;
drop policy if exists discount_cards_owner_all on public.discount_cards;
create policy discount_cards_owner_all on public.discount_cards
  for all to authenticated
  using (public.is_owner()) with check (public.is_owner());

create trigger set_updated_at_discount_cards
  before update on public.discount_cards
  for each row execute function public.set_updated_at();

-- ── 3. sales: which card, and what the program gave ─────────────────────────
alter table public.sales
  add column if not exists discount_card_id uuid references public.discount_cards(id),
  add column if not exists card_discount_centavos bigint not null default 0
    check (card_discount_centavos >= 0);

comment on column public.sales.card_discount_centavos is
  'Σ over eligible lines of (catalog − card price) — what the suki CARD
   guaranteed, for program reporting. NOT fed into P&L: the discount already
   lives in the line prices.';

create index if not exists idx_sales_discount_card
  on public.sales (discount_card_id) where discount_card_id is not null;

-- ── 4. fn_create_discount_card — owner mints a card for a customer ──────────
create or replace function public.fn_create_discount_card(
  p_customer_id uuid,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card_no text;
  v_id uuid;
  v_existing text;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can issue suki cards';
  end if;

  if not exists (
    select 1 from customers where id = p_customer_id and deleted_at is null
  ) then
    raise exception 'Customer not found';
  end if;

  select card_no into v_existing from discount_cards
  where customer_id = p_customer_id and status = 'active' and deleted_at is null;
  if v_existing is not null then
    raise exception 'That customer already has an active card (%) — deactivate it first to reissue',
      v_existing;
  end if;

  v_card_no := 'SC' || lpad(nextval('public.discount_card_seq')::text, 8, '0');

  insert into discount_cards (card_no, customer_id, issued_by, note)
  values (v_card_no, p_customer_id, auth.uid(), nullif(trim(coalesce(p_note,'')), ''))
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'card_no', v_card_no);
end $$;

revoke all on function public.fn_create_discount_card(uuid, text) from public, anon;
grant execute on function public.fn_create_discount_card(uuid, text) to authenticated;

-- ── 5. fn_set_discount_card_status — deactivate a lost card / reactivate ────
create or replace function public.fn_set_discount_card_status(
  p_card_id uuid,
  p_status text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer uuid;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can manage suki cards';
  end if;
  if p_status not in ('active','inactive') then
    raise exception 'Invalid card status: %', p_status;
  end if;

  select customer_id into v_customer from discount_cards
  where id = p_card_id and deleted_at is null;
  if v_customer is null then
    raise exception 'Card not found';
  end if;

  if p_status = 'active' and exists (
    select 1 from discount_cards
    where customer_id = v_customer and status = 'active'
      and deleted_at is null and id <> p_card_id
  ) then
    raise exception 'That customer already has another active card — deactivate it first';
  end if;

  update discount_cards set status = p_status where id = p_card_id;
end $$;

revoke all on function public.fn_set_discount_card_status(uuid, text) from public, anon;
grant execute on function public.fn_set_discount_card_status(uuid, text) to authenticated;

-- ── 6. fn_lookup_discount_card — the SHOP's only window into a card ─────────
-- Returns the POS essentials for an ACTIVE card and nothing else: who the suki
-- is + the two live percentages. No cost, no card list (a shop can resolve a
-- number it scanned, never browse). Unknown/inactive/deleted → zero rows.
create or replace function public.fn_lookup_discount_card(p_card_no text)
returns table (
  card_id uuid,
  customer_id uuid,
  customer_name text,
  customer_phone text,
  engine_pct int,
  part_pct int
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (public.is_owner() or public.auth_shop_id() is not null) then
    raise exception 'Sign in to look up a suki card';
  end if;

  return query
  select dc.id, c.id, c.name, c.phone,
         s.suki_engine_discount_pct, s.suki_part_discount_pct
  from discount_cards dc
  join customers c on c.id = dc.customer_id
  cross join settings s
  where s.id = 1
    and upper(trim(p_card_no)) = dc.card_no
    and dc.status = 'active'
    and dc.deleted_at is null
    and c.deleted_at is null;
end $$;

revoke all on function public.fn_lookup_discount_card(text) from public, anon;
grant execute on function public.fn_lookup_discount_card(text) to authenticated;

-- ── 7. fn_record_sale — 0061 body + suki card ───────────────────────────────
-- New param p_discount_card_id (default null → byte-identical behavior).
-- With a card: the card's customer IS the sale customer; per line the card
-- price = round(catalog × (1 − pct/100)) capped at cost+1, the client's price
-- is clamped to ≤ card price (guaranteed minimum), and the strict > cost floor
-- still raises on anything at/below cost.
drop function if exists public.fn_record_sale(uuid, jsonb, jsonb, jsonb, text, bigint, text);

create or replace function public.fn_record_sale(
  p_customer_id uuid default null,
  p_customer jsonb default null,
  p_part_lines jsonb default '[]'::jsonb,
  p_engine_lines jsonb default '[]'::jsonb,
  p_payment_type text default 'full',
  p_amount_paid_centavos bigint default null,
  p_payment_method text default 'cash',
  p_discount_card_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop uuid;
  v_sale_id uuid;
  v_customer_id uuid := p_customer_id;
  r record;
  v_part record;
  v_eng record;
  v_engine_id uuid;
  v_unit bigint;
  v_agreed bigint;
  v_total bigint := 0;
  v_count int := 0;
  v_amount_paid bigint;
  v_balance bigint;
  -- suki card
  v_card record;
  v_engine_pct int := 0;
  v_part_pct int := 0;
  v_card_price bigint;
  v_card_discount bigint := 0;
begin
  select shop_id into v_shop from profiles
  where id = auth.uid() and role = 'employee' and active and deleted_at is null;
  if v_shop is null then
    raise exception 'Only shop employees can record sales';
  end if;

  -- Resolve the suki card FIRST: the card is the customer, so the inline
  -- customer-creation below is skipped naturally (v_customer_id is set).
  if p_discount_card_id is not null then
    select dc.id, dc.customer_id into v_card
    from discount_cards dc
    where dc.id = p_discount_card_id
      and dc.status = 'active' and dc.deleted_at is null;
    if v_card is null then
      raise exception 'That suki card is not active — record the sale without it';
    end if;
    select suki_engine_discount_pct, suki_part_discount_pct
      into v_engine_pct, v_part_pct
    from settings where id = 1;
    v_customer_id := v_card.customer_id;
  end if;

  if v_customer_id is null and p_customer is not null
     and coalesce(trim(p_customer->>'name'), '') <> '' then
    insert into customers (name, phone, address)
    values (trim(p_customer->>'name'),
            nullif(trim(coalesce(p_customer->>'phone','')), ''),
            nullif(trim(coalesce(p_customer->>'address','')), ''))
    returning id into v_customer_id;
  end if;

  if jsonb_array_length(coalesce(p_engine_lines, '[]'::jsonb)) > 0
     and v_customer_id is null then
    raise exception 'Engine sales require a customer (for the warranty)';
  end if;

  if p_payment_type not in ('full','partial') then
    raise exception 'Invalid payment type: %', p_payment_type;
  end if;
  if p_payment_type = 'partial' and v_customer_id is null then
    raise exception 'Partial payment requires a customer — record who owes the balance';
  end if;
  if p_payment_method not in ('cash','gcash','bank','other') then
    raise exception 'Invalid payment method: %', p_payment_method;
  end if;

  insert into sales (shop_id, recorded_by, customer_id, status)
  values (v_shop, auth.uid(), v_customer_id, 'recorded')
  returning id into v_sale_id;

  -- ── parts: negotiable, floored at cost; suki card clamps to its price ──
  for r in
    select * from jsonb_to_recordset(coalesce(p_part_lines, '[]'::jsonb))
      as x(part_id uuid, qty int, unit_price_centavos bigint)
  loop
    if r.part_id is null or r.qty is null or r.qty <= 0 then
      raise exception 'Invalid sale line';
    end if;

    if not exists (
      select 1 from stock_levels
      where part_id = r.part_id and shop_id = v_shop
    ) then
      raise exception 'That item has not been delivered to your shop';
    end if;

    select name, unit, price_centavos, cost_centavos into v_part from parts
    where id = r.part_id and deleted_at is null;
    if v_part is null then
      raise exception 'Item not found in catalog';
    end if;

    if p_discount_card_id is not null then
      -- card price: pct off catalog, never at/below cost (cap at cost+1)
      v_card_price := greatest(
        round(v_part.price_centavos * (100 - v_part_pct) / 100.0)::bigint,
        v_part.cost_centavos + 1);
      -- guaranteed minimum: the cashier may go lower, never higher
      v_unit := least(coalesce(r.unit_price_centavos, v_card_price), v_card_price);
      v_card_discount := v_card_discount
        + greatest(0, v_part.price_centavos - v_card_price) * r.qty;
    else
      -- omitted price → catalog price; cost read server-side (never trusted)
      v_unit := coalesce(r.unit_price_centavos, v_part.price_centavos);
    end if;

    if v_unit <= v_part.cost_centavos then
      raise exception '₱% is at or below cost ₱% for % — enter a higher price',
        to_char(v_unit/100.0, 'FM999,999,990.00'),
        to_char(v_part.cost_centavos/100.0, 'FM999,999,990.00'),
        v_part.name;
    end if;

    insert into sale_lines
      (sale_id, part_id, qty, unit_price_centavos, line_total_centavos, description,
       agreed_price_centavos, list_reference_centavos, discount_centavos)
    values
      (v_sale_id, r.part_id, r.qty, v_unit, v_unit * r.qty, v_part.name,
       v_unit, v_part.price_centavos, greatest(0, v_part.price_centavos - v_unit));

    v_total := v_total + v_unit * r.qty;
    v_count := v_count + 1;
  end loop;

  -- ── engines: negotiable, floored at cost; suki card clamps to its price ──
  for r in
    select (x->>'engine_id')::uuid as engine_id,
           nullif(x->>'agreed_price_centavos','')::bigint as agreed
    from jsonb_array_elements(coalesce(p_engine_lines, '[]'::jsonb)) as x
  loop
    v_engine_id := r.engine_id;
    if v_engine_id is null then
      raise exception 'Invalid engine line';
    end if;

    select e.status, e.shop_id, e.serial_number, e.price_centavos, e.cost_centavos,
           em.brand, em.model
      into v_eng
    from engines e
    join engine_models em on em.id = e.engine_model_id
    where e.id = v_engine_id and e.deleted_at is null;
    if not found then
      raise exception 'Engine not found';
    end if;
    if v_eng.status <> 'delivered' or v_eng.shop_id is distinct from v_shop then
      raise exception 'That engine is not at your shop';
    end if;

    if exists (
      select 1 from sale_lines sl
      join sales s on s.id = sl.sale_id
      where sl.engine_id = v_engine_id
        and s.status in ('recorded','pending','questioned')
        and s.deleted_at is null
    ) then
      raise exception 'That engine is already in an open sale';
    end if;

    if p_discount_card_id is not null then
      v_card_price := greatest(
        round(v_eng.price_centavos * (100 - v_engine_pct) / 100.0)::bigint,
        v_eng.cost_centavos + 1);
      v_agreed := least(coalesce(r.agreed, v_card_price), v_card_price);
      v_card_discount := v_card_discount
        + greatest(0, v_eng.price_centavos - v_card_price);
    else
      v_agreed := coalesce(r.agreed, v_eng.price_centavos);
    end if;

    if v_agreed <= v_eng.cost_centavos then
      raise exception '₱% is at or below cost ₱% for % — enter a higher price',
        to_char(v_agreed/100.0, 'FM999,999,990.00'),
        to_char(v_eng.cost_centavos/100.0, 'FM999,999,990.00'),
        v_eng.serial_number;
    end if;

    insert into sale_lines
      (sale_id, engine_id, qty, unit_price_centavos, line_total_centavos, description,
       agreed_price_centavos, list_reference_centavos, discount_centavos)
    values
      (v_sale_id, v_engine_id, 1, v_agreed, v_agreed,
       v_eng.brand || ' ' || v_eng.model || ' — SN ' || v_eng.serial_number,
       v_agreed, v_eng.price_centavos, greatest(0, v_eng.price_centavos - v_agreed));

    v_total := v_total + v_agreed;
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise exception 'A sale needs at least one line';
  end if;

  if p_payment_type = 'partial' then
    v_amount_paid := coalesce(p_amount_paid_centavos, 0);
    if v_amount_paid < 0 then
      raise exception 'Amount paid cannot be negative';
    end if;
    if v_amount_paid > v_total then
      raise exception 'Amount paid cannot exceed the sale total';
    end if;
  else
    v_amount_paid := v_total;
  end if;
  v_balance := v_total - v_amount_paid;

  update sales
  set total_centavos = v_total,
      payment_type = p_payment_type,
      payment_method = p_payment_method,
      amount_paid_centavos = v_amount_paid,
      balance_due_centavos = v_balance,
      settled_at = case when v_balance = 0 then now() else null end,
      receipt_no = 'OR-' || lpad(nextval('public.receipt_no_seq')::text, 6, '0'),
      receipt_generated_at = now(),
      discount_card_id = p_discount_card_id,
      card_discount_centavos = v_card_discount
  where id = v_sale_id;

  return v_sale_id;
end $$;

revoke all on function public.fn_record_sale(uuid, jsonb, jsonb, jsonb, text, bigint, text, uuid) from public, anon;
grant execute on function public.fn_record_sale(uuid, jsonb, jsonb, jsonb, text, bigint, text, uuid) to authenticated;
