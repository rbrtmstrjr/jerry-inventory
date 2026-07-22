-- 0055_warranty_preview.sql — a warranty certificate the shop can print at the
-- COUNTER, the moment an engine sale is recorded (no Admin approval needed).
-- ============================================================================
-- Why this exists
-- ---------------
-- The official warranty record is only created when Admin APPROVES the sale
-- (fn_approve_sale, 0008). But the customer walks away with the engine at the
-- counter and needs the warranty paper THEN — they can't wait for approval.
--
-- This is a DOCUMENT, not a control: it writes nothing, creates no warranty
-- row, and deducts no stock. It just renders the certificate from the sale +
-- engine + settings, so the shop can hand it over alongside the thermal
-- receipt. The real warranty record (and claims/tracking) still comes into
-- being only on approval — unchanged.
--
-- The shop can't read this data on its own: `engines` is owner-only, and the
-- `default_warranty_months` fallback lives in the owner-only `settings` dials
-- (public_settings deliberately omits it). So a SECURITY DEFINER function is
-- the safe path — guarded in-body to the selling shop (test-definer-guards
-- requires exactly this).
--
-- Void-together: a cancelled sale (soft- or hard-deleted) returns ZERO rows
-- here, so the certificate route 404s exactly like the receipt route does —
-- delete the sale, both documents void.
--
-- Terms mirror fn_approve_sale's fallback (engine override → model default →
-- settings default → 12), with ONE deliberate difference: sold_on is the
-- sale's business_date (what the customer's copy should say), not the approval
-- date. If the numbers ever need to be identical to the approved record, that
-- record is the source of truth; this is the provisional customer copy.
-- ============================================================================

create or replace function public.fn_shop_warranty_preview(p_sale_id uuid)
returns table (
  engine_id uuid,
  serial_number text,
  condition text,
  brand text,
  model text,
  horsepower numeric,
  stroke text,
  customer_name text,
  customer_phone text,
  customer_address text,
  shop_name text,
  sold_on date,
  months int,
  expires_on date
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_shop uuid;
  v_default_months int;
begin
  -- Resolve the (live) sale's shop first; a deleted/absent sale → no rows.
  select sa.shop_id into v_shop
  from public.sales sa
  where sa.id = p_sale_id and sa.deleted_at is null;

  if v_shop is null then
    return;
  end if;

  -- In-body guard: owner sees any, a shop session only its own sale.
  if not (public.is_owner() or v_shop = public.auth_shop_id()) then
    raise exception 'Not authorized to view this warranty';
  end if;

  select s.default_warranty_months into v_default_months
  from public.settings s where s.id = 1;

  return query
  select
    e.id,
    e.serial_number,
    e.condition,
    em.brand,
    em.model,
    em.horsepower,
    em.stroke,
    c.name,
    c.phone,
    c.address,
    sh.name,
    sa.business_date,
    coalesce(e.warranty_months, em.default_warranty_months, v_default_months, 12),
    (sa.business_date
       + (coalesce(e.warranty_months, em.default_warranty_months, v_default_months, 12)
          || ' months')::interval)::date
  from public.sales sa
  join public.sale_lines l on l.sale_id = sa.id and l.engine_id is not null
  join public.engines e on e.id = l.engine_id
  join public.engine_models em on em.id = e.engine_model_id
  join public.shops sh on sh.id = sa.shop_id
  left join public.customers c on c.id = sa.customer_id
  where sa.id = p_sale_id and sa.deleted_at is null
  order by e.serial_number;
end;
$$;

revoke all on function public.fn_shop_warranty_preview(uuid) from public, anon;
grant execute on function public.fn_shop_warranty_preview(uuid) to authenticated;
