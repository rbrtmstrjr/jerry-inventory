-- ============================================================================
-- 0015_shop_product_images.sql — Shop staff can help photograph products,
-- but ONLY items currently in their own shop's inventory.
--  • Storage: employees may write product-images objects named {id}.webp
--    where {id} is a part stocked at their shop or an engine delivered there.
--  • DB: fn_set_product_image updates image_path with the same scope check,
--    and the path is locked to {id}.webp so a product can never be pointed
--    at someone else's object.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Helper: may the caller manage this product's image?
-- (uuid::text = left(name,36) comparisons keep everything cast-safe)
-- ---------------------------------------------------------------------------
create or replace function public.fn_can_edit_product_image(p_object_name text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select
    public.is_owner()
    or exists (
      select 1 from stock_levels sl
      where sl.shop_id = public.auth_shop_id()
        and sl.part_id::text = left(p_object_name, 36)
    )
    or exists (
      select 1 from engines e
      where e.shop_id = public.auth_shop_id()
        and e.status = 'delivered'
        and e.deleted_at is null
        and e.id::text = left(p_object_name, 36)
    );
$$;

revoke all on function public.fn_can_edit_product_image(text) from public, anon;
grant execute on function public.fn_can_edit_product_image(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: additional permissive policies for shop staff (owner policies
-- from 0010 remain; policies OR together)
-- ---------------------------------------------------------------------------
drop policy if exists "product images shop insert" on storage.objects;
create policy "product images shop insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'product-images' and public.fn_can_edit_product_image(name)
  );

drop policy if exists "product images shop update" on storage.objects;
create policy "product images shop update" on storage.objects
  for update to authenticated
  using (bucket_id = 'product-images' and public.fn_can_edit_product_image(name))
  with check (bucket_id = 'product-images' and public.fn_can_edit_product_image(name));

drop policy if exists "product images shop delete" on storage.objects;
create policy "product images shop delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'product-images' and public.fn_can_edit_product_image(name));

-- ---------------------------------------------------------------------------
-- Set/clear a product photo — the ONLY image write path for employees.
-- p_path is forced to '{id}.webp' (or null), never arbitrary.
-- ---------------------------------------------------------------------------
create or replace function public.fn_set_product_image(
  p_kind text,          -- 'part' | 'engine'
  p_id uuid,
  p_clear boolean default false
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_path text := p_id::text || '.webp';
begin
  if not public.fn_can_edit_product_image(v_path) then
    raise exception 'You can only manage photos for items in your own shop';
  end if;

  if p_kind = 'part' then
    update parts
    set image_path = case when p_clear then null else v_path end
    where id = p_id and deleted_at is null;
  elsif p_kind = 'engine' then
    update engines
    set image_path = case when p_clear then null else v_path end
    where id = p_id and deleted_at is null;
  else
    raise exception 'Unknown product kind %', p_kind;
  end if;

  if not found then
    raise exception 'Product not found';
  end if;

  return case when p_clear then null else v_path end;
end $$;

revoke all on function public.fn_set_product_image(text, uuid, boolean) from public, anon;
grant execute on function public.fn_set_product_image(text, uuid, boolean) to authenticated;
