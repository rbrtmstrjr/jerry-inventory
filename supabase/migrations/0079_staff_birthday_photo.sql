-- 0079 — staff birthday + photo, and today's-birthday view.
--
-- Two new columns on staff (owner-only table): a birthday (full date; the
-- celebration matches on month-day) and a photo path (stored in the existing
-- public product-images bucket, same as shop logos — no new bucket/policy).
--
-- `staff_birthdays_today` is the single source both the sidebar badge and the
-- dashboard "celebrant" card read from, so they can never disagree. Owner-only
-- (staff data is owner-only) via is_owner() inside the security_barrier view.

alter table public.staff
  add column if not exists birthday date,
  add column if not exists image_path text;

create or replace view public.staff_birthdays_today
with (security_barrier = true) as
select
  s.id,
  s.full_name,
  s.image_path,
  s.birthday,
  s.shop_id,
  sh.name       as shop_name,
  sh.color_key  as shop_color_key,
  p.title       as position
from public.staff s
left join public.shops sh on sh.id = s.shop_id
left join public.positions p on p.id = s.position_id
where s.deleted_at is null
  and s.active
  and s.birthday is not null
  -- Month-day match in PH time — a birthday is the same date every year.
  and to_char(s.birthday, 'MM-DD') = to_char(public.ph_today(), 'MM-DD')
  and public.is_owner();

grant select on public.staff_birthdays_today to authenticated;
