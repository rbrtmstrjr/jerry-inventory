-- ============================================================================
-- 0037_shop_profitability.sql — COGS snapshot + expense-scope housekeeping.
--
-- Goal: true per-shop profitability on /shops/reports —
--   Revenue − COGS = Gross Profit − shop expenses − shop payroll = Net
--   Contribution, with company overhead reported SEPARATELY (never allocated).
--
-- NOTE ON EXPENSE SCOPE — there is deliberately NO backfill here.
-- `expenses.scope` + `expenses.shop_id` + the CHECK pairing already exist
-- (0013); expenses have been scoped from day one. Forcing existing rows to
-- 'company' would ERASE real attribution (both live rows are genuinely
-- shop-scoped) and invent phantom company overhead — the exact harm the
-- 0028 (deliveries→confirmed) and 0033 (receivings→paid) backfills avoided.
-- Those columns truly did not exist before; this one does. Leave the data be.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Expense-scope housekeeping
-- ---------------------------------------------------------------------------

-- The old default ('shop') is a footgun: an insert that omits scope gets
-- scope='shop' + shop_id=null, which violates expense_scope_shop and fails.
-- 'company' is the only default that stands on its own.
alter table public.expenses alter column scope set default 'company';

-- Reporting reads are always "scope (+ shop) within a date range".
create index if not exists idx_expenses_scope_shop_date
  on public.expenses (scope, shop_id, expense_date);

-- ---------------------------------------------------------------------------
-- 2. COGS snapshot on sale_lines
--
-- Cost lives on parts.cost_centavos / engines.cost_centavos and is MUTABLE.
-- Computing COGS from it at report time means editing a part's cost silently
-- rewrites last month's profit. Stamp it at approval instead — the same thing
-- losses.value_centavos already does ("write-off value, set at approval").
--
-- Unit cost, not line cost, to match sale_lines.unit_price_centavos.
-- NULL = never approved (or approved before this migration ran).
-- ---------------------------------------------------------------------------
alter table public.sale_lines
  add column if not exists unit_cost_centavos bigint
    check (unit_cost_centavos is null or unit_cost_centavos >= 0);

comment on column public.sale_lines.unit_cost_centavos is
  'Cost per unit frozen at approval (COGS basis). NULL until approved.';

-- Backfill already-approved lines from current cost. This is the same number
-- a live lookup would produce today, so no figure moves — it just stops
-- drifting from here on.
update public.sale_lines sl
   set unit_cost_centavos = p.cost_centavos
  from public.sales s, public.parts p
 where sl.sale_id = s.id
   and s.status = 'approved'
   and s.deleted_at is null
   and sl.part_id = p.id
   and sl.unit_cost_centavos is null;

update public.sale_lines sl
   set unit_cost_centavos = e.cost_centavos
  from public.sales s, public.engines e
 where sl.sale_id = s.id
   and s.status = 'approved'
   and s.deleted_at is null
   and sl.engine_id = e.id
   and sl.unit_cost_centavos is null;

-- COGS queries: approved sales for a shop within a date range.
create index if not exists idx_sale_lines_cost
  on public.sale_lines (sale_id) include (unit_cost_centavos, qty);

-- ---------------------------------------------------------------------------
-- 3. fn_approve_sale — stamp the cost as each line is approved.
--
-- Body is otherwise byte-identical to the live definition (0008); the only
-- additions are the two `update sale_lines set unit_cost_centavos` writes.
-- fn_approve_batch delegates here per sale, so batch approval inherits this
-- with no change of its own.
-- ---------------------------------------------------------------------------
create or replace function public.fn_approve_sale(p_sale_id uuid, p_note text default null::text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_sale record;
  l record;
  v_qty int;
  v_eng record;
  v_months int;
  v_sold_on date;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can approve sales';
  end if;

  select * into v_sale from sales
  where id = p_sale_id and deleted_at is null
  for update;

  if v_sale is null then
    raise exception 'Sale not found';
  end if;
  if v_sale.status not in ('pending','questioned') then
    raise exception 'Sale already reviewed (status: %)', v_sale.status;
  end if;

  for l in
    select * from sale_lines where sale_id = p_sale_id
  loop
    if l.part_id is not null then
      select qty into v_qty from stock_levels
      where part_id = l.part_id and shop_id = v_sale.shop_id
      for update;

      if v_qty is null or v_qty < l.qty then
        raise exception 'Cannot approve: % would drive shop stock negative (on hand: %, selling: %)',
          coalesce(l.description, 'item'), coalesce(v_qty, 0), l.qty;
      end if;

      update stock_levels set qty = qty - l.qty
      where part_id = l.part_id and shop_id = v_sale.shop_id;

      insert into stock_movements (movement_type, part_id, qty_change, shop_id, actor, sale_id, note)
      values ('sale', l.part_id, -l.qty, v_sale.shop_id, auth.uid(), p_sale_id, l.description);

      -- freeze the COGS basis for this line
      update sale_lines
      set unit_cost_centavos = (select cost_centavos from parts where id = l.part_id)
      where id = l.id;

    else
      select e.*, em.default_warranty_months into v_eng
      from engines e
      join engine_models em on em.id = e.engine_model_id
      where e.id = l.engine_id and e.deleted_at is null
      for update of e;

      if v_eng is null then
        raise exception 'Engine on this sale no longer exists';
      end if;
      if v_eng.status <> 'delivered' or v_eng.shop_id is distinct from v_sale.shop_id then
        raise exception 'Cannot approve: engine % is not at this shop anymore (status: %)',
          v_eng.serial_number, v_eng.status;
      end if;
      if v_sale.customer_id is null then
        raise exception 'Engine sales need a customer before approval';
      end if;

      update engines
      set status = 'sold', customer_id = v_sale.customer_id, sold_at = now()
      where id = l.engine_id;

      -- auto-create the warranty: engine override → model default → settings
      v_months := coalesce(
        v_eng.warranty_months,
        v_eng.default_warranty_months,
        (select default_warranty_months from settings where id = 1),
        12
      );
      v_sold_on := public.ph_today();

      insert into warranties (engine_id, sale_id, customer_id, sold_on, months, expires_on)
      values (l.engine_id, p_sale_id, v_sale.customer_id, v_sold_on, v_months,
              (v_sold_on + (v_months || ' months')::interval)::date)
      on conflict (engine_id) do update
        set sale_id = excluded.sale_id,
            customer_id = excluded.customer_id,
            sold_on = excluded.sold_on,
            months = excluded.months,
            expires_on = excluded.expires_on,
            deleted_at = null;

      insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, sale_id, note)
      values ('sale', l.engine_id, -1, v_sale.shop_id, auth.uid(), p_sale_id, l.description);

      -- freeze the COGS basis: this exact serial's own cost
      update sale_lines
      set unit_cost_centavos = v_eng.cost_centavos
      where id = l.id;
    end if;
  end loop;

  update sales
  set status = 'approved',
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      owner_note = coalesce(p_note, owner_note)
  where id = p_sale_id;
end $function$;

revoke all on function public.fn_approve_sale(uuid, text) from public, anon;
grant execute on function public.fn_approve_sale(uuid, text) to authenticated;
