-- ---------------------------------------------------------------------------
-- 0084 — flattened registry views for server-side pagination
--
-- The Warranties & Serials page loaded EVERY warranty and EVERY engine into the
-- browser (deep joins, all rows) and paginated client-side. At 1.5k warranties
-- and 6.5k engines that is a multi-MB payload the client then has to filter and
-- sort — cost grows with the table, so it only gets worse.
--
-- Server-side pagination needs to FILTER, SORT and SEARCH in SQL, but the
-- searchable fields (serial, customer, model) live across four joined tables,
-- and PostgREST cannot OR across embedded resources. So flatten them here —
-- exactly the pattern `reviewed_items` (0030) and `movement_journal` (0045)
-- already use: one row per record, related names resolved, plus a lower-cased
-- `search_text` the page can `ilike` against.
--
-- Read-only, owner-only (is_owner() inside the view, like master_low_stock).
-- No new data, no policy change: these expose exactly what the owner's page
-- already fetched — just shaped so the DATABASE can do the paging work.
-- ---------------------------------------------------------------------------

-- ── warranty_registry — one row per live warranty ───────────────────────────
create or replace view public.warranty_registry
with (security_barrier = true) as
select
  w.id,
  w.engine_id,
  e.serial_number,
  trim(concat_ws(' ', em.brand, em.model))        as model,
  em.horsepower,
  c.name                                          as customer,
  c.phone                                         as customer_phone,
  sh.name                                         as shop,
  sh.color_key                                    as shop_color_key,
  w.sold_on,
  w.months,
  w.expires_on,
  (w.expires_on >= public.ph_today())             as active,
  (select count(*) from public.warranty_claims wc
    where wc.warranty_id = w.id and wc.deleted_at is null) as claims_count,
  lower(concat_ws(' ', e.serial_number, c.name, c.phone, em.brand, em.model, sh.name))
                                                  as search_text
from public.warranties w
left join public.engines e        on e.id = w.engine_id
left join public.engine_models em on em.id = e.engine_model_id
left join public.customers c      on c.id = w.customer_id
left join public.sales s          on s.id = w.sale_id
left join public.shops sh         on sh.id = s.shop_id
where w.deleted_at is null
  and public.is_owner();

revoke all on public.warranty_registry from anon;
grant select on public.warranty_registry to authenticated;

-- ── engine_registry — one row per engine ever received (incl. written-off) ──
-- Serves BOTH owner engine lists: Warranties → Serials (chain of custody) and
-- Master Inventory → Engines (catalog + cost/price). One flattened source, so
-- the two can't drift. Cost stays owner-only: the view is is_owner()-guarded.
create or replace view public.engine_registry
with (security_barrier = true) as
select
  e.id,
  e.serial_number,
  e.engine_model_id,
  em.brand,
  em.model                                        as model_name,
  trim(concat_ws(' ', em.brand, em.model))        as model,
  em.horsepower,
  case when e.deleted_at is not null then 'written_off' else e.status::text end as status,
  e.condition::text                               as condition,
  e.cost_centavos,
  e.price_centavos,
  e.warranty_months,
  e.image_path,
  e.shop_id,
  sh.name                                         as shop,
  sh.color_key                                    as shop_color_key,
  c.name                                          as customer,
  c.phone                                         as customer_phone,
  e.sold_at,
  e.created_at,
  e.deleted_at,
  lower(concat_ws(' ', e.serial_number, em.brand, em.model, sh.name, c.name)) as search_text
from public.engines e
left join public.engine_models em on em.id = e.engine_model_id
left join public.shops sh         on sh.id = e.shop_id
left join public.customers c      on c.id = e.customer_id
where public.is_owner();

revoke all on public.engine_registry from anon;
grant select on public.engine_registry to authenticated;

-- Indexes backing the default orders + the joins these views walk. Sorting a
-- paged query is only cheap if the DB can walk an index instead of sorting the
-- whole table for every page.
create index if not exists idx_warranties_sold_on on public.warranties (sold_on desc);
create index if not exists idx_warranties_sale on public.warranties (sale_id);
create index if not exists idx_warranties_customer on public.warranties (customer_id);
create index if not exists idx_engines_created on public.engines (created_at desc);
create index if not exists idx_engines_serial on public.engines (serial_number);
create index if not exists idx_warranty_claims_warranty on public.warranty_claims (warranty_id);
