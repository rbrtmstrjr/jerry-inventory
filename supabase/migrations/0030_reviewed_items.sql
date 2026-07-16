-- ============================================================================
-- 0030_reviewed_items.sql — one queryable history of everything reviewed.
--
-- Backs the Reviewed History section on /approvals: sales + losses + utang
-- payments in ONE list so the UI can filter/sort/paginate server-side instead
-- of stitching three uncoordinated lists together client-side.
--
-- OWNER-ONLY: the `public.is_owner()` guard sits inside the view (a view runs
-- as its owner and bypasses the base tables' RLS, so the guard must live here
-- — same pattern as master_low_stock).
--
-- Read-only by construction: it is a view over the source rows. Nothing here
-- can re-approve, reverse, or move stock.
--
-- NOTE on utang payments: since 0026 they post on record (status 'approved')
-- and a mistake is VOIDED via soft-delete. Voided rows are excluded here and
-- live in the Receivables payment history with their void reason, which is
-- where that story belongs.
-- ============================================================================

drop view if exists public.reviewed_items;

create view public.reviewed_items
with (security_barrier = true) as

-- ─────────────────────────────── SALES ───────────────────────────────
select
  'sale'::text                                        as item_type,
  s.id,
  s.shop_id,
  sh.name                                             as shop_name,
  s.status::text                                      as status,
  s.reviewed_at,
  -- questioned items never get reviewed_at (only reject sets it), so fall
  -- back so they still sort/filter sensibly
  coalesce(s.reviewed_at, s.updated_at, s.created_at) as event_at,
  ((coalesce(s.reviewed_at, s.updated_at, s.created_at)
      at time zone 'Asia/Manila')::date)              as event_date,
  s.created_at,
  s.business_date,
  s.total_centavos                                    as amount_centavos,
  coalesce(li.summary, 'Sale')                        as summary,
  s.customer_id,
  c.name                                              as customer_name,
  s.owner_note,
  s.batch_id,
  lower(concat_ws(' ', sh.name, c.name, li.summary, s.receipt_no)) as search_text
from public.sales s
join public.shops sh on sh.id = s.shop_id
left join public.customers c on c.id = s.customer_id
left join lateral (
  select string_agg(
           sl.description || case when sl.qty > 1 then ' × ' || sl.qty else '' end,
           ', ' order by sl.created_at
         ) as summary
  from public.sale_lines sl
  where sl.sale_id = s.id
) li on true
where s.deleted_at is null
  and s.status in ('approved','rejected','questioned')
  and public.is_owner()

union all

-- ─────────────────────────────── LOSSES ──────────────────────────────
select
  'loss'::text,
  l.id,
  l.shop_id,
  sh.name,
  l.status::text,
  l.reviewed_at,
  coalesce(l.reviewed_at, l.updated_at, l.created_at),
  ((coalesce(l.reviewed_at, l.updated_at, l.created_at)
      at time zone 'Asia/Manila')::date),
  l.created_at,
  l.business_date,
  coalesce(l.value_centavos, 0),
  coalesce(l.description, 'Item') || ' × ' || l.qty || ' · ' || l.reason::text,
  null::uuid,
  null::text,
  l.owner_note,
  l.batch_id,
  lower(concat_ws(' ', sh.name, l.description, l.reason::text, l.note))
from public.losses l
join public.shops sh on sh.id = l.shop_id
where l.deleted_at is null
  and l.status in ('approved','rejected','questioned')
  and public.is_owner()

union all

-- ───────────────────────── UTANG PAYMENTS ────────────────────────────
select
  'utang_payment'::text,
  up.id,
  up.shop_id,
  sh.name,
  up.status::text,
  up.reviewed_at,
  coalesce(up.reviewed_at, up.created_at),
  ((coalesce(up.reviewed_at, up.created_at)
      at time zone 'Asia/Manila')::date),
  up.created_at,
  up.business_date,
  up.amount_centavos,
  'Utang payment — ' || coalesce(c.name, 'walk-in'),
  up.customer_id,
  c.name,
  up.owner_note,
  up.batch_id,
  lower(concat_ws(' ', sh.name, c.name, sa.receipt_no))
from public.utang_payments up
join public.shops sh on sh.id = up.shop_id
left join public.customers c on c.id = up.customer_id
left join public.sales sa on sa.id = up.sale_id
where up.deleted_at is null
  and up.status in ('approved','rejected','questioned')
  and public.is_owner();

revoke all on public.reviewed_items from anon;
grant select on public.reviewed_items to authenticated;
