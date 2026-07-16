-- ---------------------------------------------------------------------------
-- 0046 — Supplier price comparison: quotes + two derived views
--
-- "Which supplier is cheapest for this product?" — answered from two sources
-- with very different trust:
--
--   • LAST PAID — derived entirely from existing receiving_lines/receivings.
--     Zero data entry; this is what the business actually handed over.
--   • QUOTES — a new, owner-entered table. A quote is a claim, not a payment,
--     and it goes stale: past its valid_until, or older than
--     settings.quote_stale_days (default 60).
--
-- PROVENANCE IS THE FEATURE. Every price the views emit carries its source and
-- date, because "₱165 vs ₱180" is a lie when one is an 8-month-old paid price
-- and the other a fresh quote. The effective compare price is: fresh quote if
-- one exists, else last-paid, else the stale quote (flagged — stale is shown,
-- never hidden, and never silently treated as fresh).
--
-- COST NEVER LEAKS TO A SHOP. Both views carry `public.is_owner()` in their
-- WHERE (the master_low_stock pattern): they are views, so they have no RLS of
-- their own, and everything here is cost data — the one thing the whole schema
-- exists to keep away from shop sessions.
--
-- `quote_stale_days` finally becomes a REAL setting. It was deliberately left
-- out of the Settings overhaul because no quotes feature existed and a setting
-- that controls nothing is decoration. Now the feature exists; the setting and
-- its editor arrive together.
-- ---------------------------------------------------------------------------

alter table public.settings
  add column if not exists quote_stale_days int not null default 60
    check (quote_stale_days between 1 and 365);

comment on column public.settings.quote_stale_days is
  'A supplier quote older than this (or past its valid_until) is flagged stale
   and stops being the effective compare price. Owner-editable from Settings →
   Alerts.';

-- ── supplier_quotes ─────────────────────────────────────────────────────────
create table if not exists public.supplier_quotes (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id),
  -- Exactly one of the two, same XOR shape as receiving_lines/stock_movements.
  part_id uuid references public.parts(id),
  engine_model_id uuid references public.engine_models(id),
  unit_cost_centavos bigint not null check (unit_cost_centavos > 0),
  quoted_at date not null default public.ph_today(),
  valid_until date,
  note text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint quote_item check ((part_id is null) <> (engine_model_id is null)),
  constraint quote_valid_range check (valid_until is null or valid_until >= quoted_at)
);

comment on table public.supplier_quotes is
  'Owner-entered supplier price quotes. A quote is a CLAIM — receiving_lines is
   what was actually paid. Soft-deleted like everything else.';

create index if not exists idx_quotes_part
  on public.supplier_quotes (part_id, quoted_at desc) where part_id is not null;
create index if not exists idx_quotes_engine_model
  on public.supplier_quotes (engine_model_id, quoted_at desc) where engine_model_id is not null;
create index if not exists idx_quotes_supplier
  on public.supplier_quotes (supplier_id);

alter table public.supplier_quotes enable row level security;
revoke all on public.supplier_quotes from anon;
create policy supplier_quotes_owner_all on public.supplier_quotes
  for all to authenticated
  using (public.is_owner()) with check (public.is_owner());

create trigger set_updated_at_supplier_quotes
  before update on public.supplier_quotes
  for each row execute function public.set_updated_at();

-- ── supplier_product_prices_history ─────────────────────────────────────────
-- Last price actually PAID per (supplier × product), from the receivings that
-- already exist. Engine lines reference a specific serial; grouping is by its
-- MODEL — "what does a Suzuki DF15 cost from this supplier", not "what did
-- serial X cost". One definition of last-paid: the comparison view reads this,
-- so the two can never disagree about what was paid.
create or replace view public.supplier_product_prices_history
with (security_barrier = true) as
select distinct on (r.supplier_id, coalesce(rl.part_id, e.engine_model_id))
  r.supplier_id,
  s.name as supplier_name,
  rl.part_id,
  e.engine_model_id,
  rl.unit_cost_centavos,
  r.received_at,
  r.id as receiving_id
from public.receiving_lines rl
join public.receivings r on r.id = rl.receiving_id and r.deleted_at is null
join public.suppliers s on s.id = r.supplier_id
left join public.engines e on e.id = rl.engine_id
where r.supplier_id is not null
  and public.is_owner()
-- (received_at, id) — deterministic when two lines of one receiving share a
-- timestamp, same rule as the movements ledger.
order by r.supplier_id, coalesce(rl.part_id, e.engine_model_id),
         r.received_at desc, rl.id desc;

revoke all on public.supplier_product_prices_history from anon;
grant select on public.supplier_product_prices_history to authenticated;

-- ── supplier_price_comparison ────────────────────────────────────────────────
-- One row per (product × supplier) that has EITHER a paid history OR a live
-- quote. Window functions stamp is_cheapest and the preferred supplier's own
-- effective price onto every row, so the page can say "Preferred is ₱15 more"
-- without a second query.
create or replace view public.supplier_price_comparison
with (security_barrier = true) as
with latest_quote as (
  select distinct on (q.supplier_id, coalesce(q.part_id, q.engine_model_id))
    q.id, q.supplier_id, q.part_id, q.engine_model_id,
    q.unit_cost_centavos, q.quoted_at, q.valid_until, q.note
  from public.supplier_quotes q
  where q.deleted_at is null
  order by q.supplier_id, coalesce(q.part_id, q.engine_model_id),
           q.quoted_at desc, q.created_at desc
),
pairs as (
  select
    coalesce(lp.supplier_id, lq.supplier_id)         as supplier_id,
    coalesce(lp.part_id, lq.part_id)                 as part_id,
    coalesce(lp.engine_model_id, lq.engine_model_id) as engine_model_id,
    lp.unit_cost_centavos as last_paid_centavos,
    lp.received_at        as last_paid_at,
    lp.receiving_id,
    lq.id                 as quote_id,
    lq.unit_cost_centavos as quote_centavos,
    lq.quoted_at,
    lq.valid_until,
    lq.note               as quote_note
  from public.supplier_product_prices_history lp
  full outer join latest_quote lq
    on lq.supplier_id = lp.supplier_id
   and coalesce(lq.part_id, lq.engine_model_id)
     = coalesce(lp.part_id, lp.engine_model_id)
),
enriched as (
  select
    pr.*,
    s.name as supplier_name,
    coalesce(pt.name, em.brand || ' ' || em.model) as product_name,
    pt.sku,
    coalesce(pt.unit, 'unit') as unit,
    pc.name as category_name,
    case when pr.part_id is not null then 'part' else 'engine_model' end as kind,
    coalesce(pt.preferred_supplier_id, em.preferred_supplier_id) as preferred_supplier_id,
    -- Stale: past its own valid_until, or older than the owner's dial.
    (pr.quote_id is not null and (
       (pr.valid_until is not null and pr.valid_until < public.ph_today())
       or pr.quoted_at < public.ph_today()
          - (select st.quote_stale_days from public.settings st where st.id = 1)
    )) as quote_stale
  from pairs pr
  join public.suppliers s on s.id = pr.supplier_id
  left join public.parts pt on pt.id = pr.part_id and pt.deleted_at is null
  left join public.product_categories pc on pc.id = pt.category_id
  left join public.engine_models em on em.id = pr.engine_model_id
  -- A soft-deleted part leaves both joins empty: drop the orphan row.
  where (pt.id is not null or em.id is not null)
),
effective as (
  select
    e.*,
    case
      when e.quote_id is not null and not e.quote_stale then e.quote_centavos
      when e.last_paid_centavos is not null            then e.last_paid_centavos
      else e.quote_centavos
    end as effective_centavos,
    case
      when e.quote_id is not null and not e.quote_stale then 'quote'
      when e.last_paid_centavos is not null            then 'paid'
      else 'stale_quote'
    end as effective_source,
    case
      when e.quote_id is not null and not e.quote_stale then e.quoted_at
      when e.last_paid_centavos is not null            then e.last_paid_at::date
      else e.quoted_at
    end as effective_as_of
  from enriched e
)
select
  f.*,
  (f.supplier_id = f.preferred_supplier_id) as is_preferred,
  min(f.effective_centavos)
    over (partition by coalesce(f.part_id, f.engine_model_id)) as cheapest_centavos,
  (f.effective_centavos = min(f.effective_centavos)
    over (partition by coalesce(f.part_id, f.engine_model_id))) as is_cheapest,
  -- The preferred supplier's own effective price, stamped on every row of the
  -- product so "Preferred is ₱X more" needs no second query. NULL when the
  -- product has no preferred supplier or the preferred one has no price yet.
  min(case when f.supplier_id = f.preferred_supplier_id then f.effective_centavos end)
    over (partition by coalesce(f.part_id, f.engine_model_id)) as preferred_effective_centavos,
  count(*) over (partition by coalesce(f.part_id, f.engine_model_id)) as supplier_count
from effective f
where public.is_owner();

comment on view public.supplier_price_comparison is
  'Owner-only. One row per product × supplier with paid history and/or a quote.
   effective_centavos = fresh quote, else last-paid, else stale quote — and
   effective_source/effective_as_of say which, because a bare number comparing
   a stale quote to a fresh payment is worse than no comparison.';

revoke all on public.supplier_price_comparison from anon;
grant select on public.supplier_price_comparison to authenticated;
