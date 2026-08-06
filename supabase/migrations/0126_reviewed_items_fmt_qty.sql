-- ---------------------------------------------------------------------------
-- 0126 — reviewed_items builds its summary text from a quantity. Two defects,
--        both introduced the moment 0116 made qty numeric(12,1).
--
-- The Approval Queue's reviewed history renders, today:
--
--     Water Pump 140-Z9C × 2.0, Piston Kit 360-Z6C
--
-- 1. `' × ' || sl.qty` — concatenating a numeric renders it WITH its scale, so
--    every whole quantity grew a ".0". 387 of 391 products are pieces, so this
--    is nearly every line in the history. Exactly what 0123 added fmt_qty() for;
--    0123 fixed fn_record_count_shortages and did not sweep the views.
--
-- 2. `case when sl.qty > 1` — the worse one, and invisible in seeded data.
--    The intent is "don't print × 1". With integers `> 1` and `<> 1` were the
--    same test. With tenths they are not: 0.5 is not greater than 1, so a
--    HALF-KILO SALE LINE PRINTS NO QUANTITY AT ALL —
--
--        "ZZ-QA Nails"        (0.5 kg sold, quantity silently omitted)
--
--    on the one screen the owner uses to review what a shop already did. The
--    fix is `<> 1`, which keeps the original intent and is correct for tenths.
--
--    The loss arm has defect 1 only; it always prints the quantity.
--
-- WHY A WHOLE-VIEW REDEFINITION: `create or replace view` cannot change a
-- column list, and this is a 4-arm union whose text is the contract. The body
-- below is 0051's, byte-for-byte, with ONLY the two summary expressions
-- changed — every other line, the union order, the RLS predicate
-- (`public.is_owner()` on all four arms) and the column list are untouched.
--
-- Grants are restated and anon re-revoked: dropping a view discards both, and
-- Supabase's default privileges re-grant anon on any newly created object
-- (the 0122 lesson).
--
-- Read-only view; no data changes; safe to run while the shops are open.
-- ---------------------------------------------------------------------------

drop view if exists public.reviewed_items;

create view public.reviewed_items
with (security_barrier = true) as

select
  'sale'::text                                        as item_type,
  s.id,
  s.shop_id,
  sh.name                                             as shop_name,
  s.status::text                                      as status,
  s.reviewed_at,
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
           -- `<> 1`, not `> 1`: a 0.5 kg line must still show its quantity.
           -- fmt_qty so a whole 2 prints "2", not "2.0".
           sl.description
             || case when sl.qty <> 1 then ' × ' || public.fmt_qty(sl.qty) else '' end,
           ', ' order by sl.created_at
         ) as summary
  from public.sale_lines sl
  where sl.sale_id = s.id
) li on true
where s.deleted_at is null
  and s.status in ('approved','rejected','questioned')
  and public.is_owner()

union all

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
  coalesce(l.description, 'Item') || ' × ' || public.fmt_qty(l.qty)
    || ' · ' || l.reason::text,
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
  and public.is_owner()

union all

select
  'expense'::text,
  e.id,
  e.shop_id,
  sh.name,
  e.status::text,
  e.approved_at,
  coalesce(e.approved_at, e.updated_at, e.created_at),
  ((coalesce(e.approved_at, e.updated_at, e.created_at)
      at time zone 'Asia/Manila')::date),
  e.created_at,
  e.expense_date,
  e.amount,
  ec.name || ' — ' || e.description,
  null::uuid,
  null::text,
  e.review_note,
  e.batch_id,
  lower(concat_ws(' ', sh.name, ec.name, e.description, e.paid_to))
from public.expenses e
join public.shops sh on sh.id = e.shop_id
join public.expense_categories ec on ec.id = e.category_id
where e.deleted_at is null
  and e.source = 'shop'
  and e.status in ('approved','rejected','questioned')
  and public.is_owner();

revoke all on public.reviewed_items from anon;
grant select on public.reviewed_items to authenticated;
