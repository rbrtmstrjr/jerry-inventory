-- ============================================================================
-- 0010_product_images.sql — Product images.
-- The DB stores a Storage object path (within the product-images bucket),
-- never bytes or full URLs. Bucket is public-read; only the owner writes.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- parts.image_url (never used, held URLs by design mistake) → image_path
-- ---------------------------------------------------------------------------
do $$ begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'parts' and column_name = 'image_url'
  ) then
    alter table public.parts rename column image_url to image_path;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- shop_stock view: column rename requires drop + recreate (same definition,
-- employee-safe: scoped to caller's shop, NO cost column)
-- ---------------------------------------------------------------------------
drop view if exists public.shop_stock;

create view public.shop_stock
with (security_barrier = true) as
select
  sl.shop_id,
  p.id as part_id,
  p.name,
  pc.name as category,
  p.sku,
  p.barcode,
  p.unit,
  p.price_centavos,      -- selling price only; cost is NOT exposed
  p.reorder_level,
  p.image_path,
  sl.qty
from public.stock_levels sl
join public.parts p on p.id = sl.part_id and p.deleted_at is null
left join public.product_categories pc on pc.id = p.category_id
where sl.shop_id is not null
  and (public.is_owner() or sl.shop_id = public.auth_shop_id());

revoke all on public.shop_stock from anon;
grant select on public.shop_stock to authenticated;

-- ---------------------------------------------------------------------------
-- Storage bucket: public read (product photos are non-sensitive, CDN-served)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = true;

-- ---------------------------------------------------------------------------
-- Storage RLS: mirror the app's access model.
-- Owner: INSERT / UPDATE / DELETE. Everyone: SELECT (bucket is public anyway).
-- ---------------------------------------------------------------------------
drop policy if exists "product images owner insert" on storage.objects;
create policy "product images owner insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'product-images' and public.is_owner());

drop policy if exists "product images owner update" on storage.objects;
create policy "product images owner update" on storage.objects
  for update to authenticated
  using (bucket_id = 'product-images' and public.is_owner())
  with check (bucket_id = 'product-images' and public.is_owner());

drop policy if exists "product images owner delete" on storage.objects;
create policy "product images owner delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'product-images' and public.is_owner());

drop policy if exists "product images public read" on storage.objects;
create policy "product images public read" on storage.objects
  for select to public
  using (bucket_id = 'product-images');
