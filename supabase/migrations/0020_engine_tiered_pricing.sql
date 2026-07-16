-- ============================================================================
-- 0020_engine_tiered_pricing.sql — negotiable 3-tier pricing for engines.
-- Owner sets three margin % (floor/mid/asking) per engine; peso prices compute
-- from cost and are STORED (stable history, so a later cost change never
-- silently moves an in-progress quote). Employees see only the three selling
-- prices + the floor as their hard limit — never cost or margins. Sale lines
-- gain agreed price / discount; sales gain partial-payment + receipt fields.
--
-- Generic by design: fn_compute_tier_price + the stored-tier shape can be
-- reused for parts later; only engines are wired up now.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Engine tier columns (margins owner-set; peso prices computed + stored)
-- ---------------------------------------------------------------------------
alter table public.engines
  add column if not exists margin_floor_pct numeric(6,2),
  add column if not exists margin_mid_pct numeric(6,2),
  add column if not exists margin_asking_pct numeric(6,2),
  add column if not exists price_floor_centavos bigint,
  add column if not exists price_mid_centavos bigint,
  add column if not exists price_asking_centavos bigint;

-- ---------------------------------------------------------------------------
-- 2. Generic tier-price computation (reusable for parts later)
--    price = cost * (1 + margin% / 100), rounded to the centavo.
-- ---------------------------------------------------------------------------
create or replace function public.fn_compute_tier_price(
  p_cost_centavos bigint,
  p_margin_pct numeric
) returns bigint
language sql immutable
as $$
  select case
    when p_margin_pct is null or p_cost_centavos is null then null
    else round(p_cost_centavos::numeric * (1 + p_margin_pct / 100.0))::bigint
  end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Keep an engine's stored tier prices in sync whenever cost or margins
--    change. Fires for every write path (receiving fn, updateEngine, direct).
--    When margins aren't all set, leave stored prices untouched (legacy engines
--    keep their single price until the owner configures margins).
-- ---------------------------------------------------------------------------
create or replace function public.engines_sync_tier_prices()
returns trigger
language plpgsql
as $$
begin
  if new.margin_floor_pct is not null
     and new.margin_mid_pct is not null
     and new.margin_asking_pct is not null then
    if not (new.margin_floor_pct <= new.margin_mid_pct
            and new.margin_mid_pct <= new.margin_asking_pct) then
      raise exception
        'Margins must be ordered floor%% <= mid%% <= asking%% (got %, %, %)',
        new.margin_floor_pct, new.margin_mid_pct, new.margin_asking_pct;
    end if;
    new.price_floor_centavos  := public.fn_compute_tier_price(new.cost_centavos, new.margin_floor_pct);
    new.price_mid_centavos    := public.fn_compute_tier_price(new.cost_centavos, new.margin_mid_pct);
    new.price_asking_centavos := public.fn_compute_tier_price(new.cost_centavos, new.margin_asking_pct);
    new.price_centavos        := new.price_asking_centavos;  -- headline = asking tier
  end if;
  return new;
end $$;

drop trigger if exists trg_engines_sync_tier_prices on public.engines;
create trigger trg_engines_sync_tier_prices
  before insert or update on public.engines
  for each row execute function public.engines_sync_tier_prices();

-- ---------------------------------------------------------------------------
-- 4. Backfill: existing engines' tiers default to their current single price,
--    so shop_engines has non-null tiers now and the floor == today's price
--    (nothing can sell below current price until the owner sets margins).
--    Margins stay NULL, so the trigger leaves these prices alone.
-- ---------------------------------------------------------------------------
update public.engines
set price_floor_centavos  = coalesce(price_floor_centavos, price_centavos),
    price_mid_centavos    = coalesce(price_mid_centavos, price_centavos),
    price_asking_centavos = coalesce(price_asking_centavos, price_centavos);

-- ---------------------------------------------------------------------------
-- 5. Sale line: negotiated price + reference + discount (engine lines).
--    unit_price / line_total still hold the agreed price so totals are
--    consistent; agreed/reference/discount add negotiation context.
-- ---------------------------------------------------------------------------
alter table public.sale_lines
  add column if not exists agreed_price_centavos bigint,
  add column if not exists list_reference_centavos bigint,
  add column if not exists discount_centavos bigint;

-- ---------------------------------------------------------------------------
-- 6. Sale: partial payment split + receipt.
-- ---------------------------------------------------------------------------
alter table public.sales
  add column if not exists payment_type text not null default 'full'
    check (payment_type in ('full','partial')),
  add column if not exists amount_paid_centavos bigint,
  add column if not exists balance_due_centavos bigint not null default 0,
  add column if not exists receipt_no text,
  add column if not exists receipt_generated_at timestamptz;

create sequence if not exists public.receipt_no_seq;

-- ---------------------------------------------------------------------------
-- 7. shop_engines view: expose the three tier prices; cost + margins stay
--    hidden (employees never see them). Coalesce to price_centavos so legacy
--    engines without margins still return sensible tiers.
-- ---------------------------------------------------------------------------
drop view if exists public.shop_engines;

create view public.shop_engines
with (security_barrier = true) as
select
  e.id as engine_id,
  e.serial_number,
  em.brand,
  em.model,
  em.horsepower,
  em.stroke,
  e.condition,
  e.price_centavos,      -- headline (asking); kept for backward compatibility
  coalesce(e.price_floor_centavos,  e.price_centavos) as price_floor_centavos,
  coalesce(e.price_mid_centavos,    e.price_centavos) as price_mid_centavos,
  coalesce(e.price_asking_centavos, e.price_centavos) as price_asking_centavos,
  e.status,
  e.shop_id,
  e.image_path
from public.engines e
join public.engine_models em on em.id = e.engine_model_id
where e.deleted_at is null
  and e.status = 'delivered'
  and e.shop_id is not null
  and (public.is_owner() or e.shop_id = public.auth_shop_id());

revoke all on public.shop_engines from anon;
grant select on public.shop_engines to authenticated;
