-- ============================================================================
-- 0019_versioned_image_paths.sql — cache-proof product photos.
-- Replacing a photo at a FIXED path ({id}.webp) kept serving the stale file
-- from the browser/CDN cache (upload succeeds, URL never changes). Uploads
-- now use versioned names {id}-<epoch-ms>.webp so every replace gets a fresh
-- URL. Storage policies already scope by the first 36 chars (the product id),
-- so they accept versioned names unchanged; only fn_set_product_image needs
-- to take the path — still locked to the product's own id.
-- ============================================================================

drop function if exists public.fn_set_product_image(text, uuid, boolean);

create or replace function public.fn_set_product_image(
  p_kind text,          -- 'part' | 'engine'
  p_id uuid,
  p_path text default null,   -- '{id}.webp' or '{id}-<digits>.webp' only
  p_clear boolean default false
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_path text;
begin
  if not public.fn_can_edit_product_image(p_id::text || '.webp') then
    raise exception 'You can only manage photos for items in your own shop';
  end if;

  if p_clear then
    v_path := null;
  else
    v_path := coalesce(p_path, p_id::text || '.webp');
    if v_path !~ ('^' || p_id::text || '(-[0-9]+)?\.webp$') then
      raise exception 'Invalid image path for this product';
    end if;
  end if;

  if p_kind = 'part' then
    update parts
    set image_path = v_path
    where id = p_id and deleted_at is null;
  elsif p_kind = 'engine' then
    update engines
    set image_path = v_path
    where id = p_id and deleted_at is null;
  else
    raise exception 'Unknown product kind %', p_kind;
  end if;

  if not found then
    raise exception 'Product not found';
  end if;

  return v_path;
end $$;

revoke all on function public.fn_set_product_image(text, uuid, text, boolean) from public, anon;
grant execute on function public.fn_set_product_image(text, uuid, text, boolean) to authenticated;
