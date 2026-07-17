-- ---------------------------------------------------------------------------
-- 0049 — Catalog INSERT lockdown: creation happens ONLY inside fn_receive_stock
--
-- 0048 stated the invariant ("a product enters the system because a supplier
-- delivered it") but the UI still had Add Part / Add Engine dialogs creating
-- catalog rows with no supplier and no stock — and nothing stopped the next
-- agent from re-adding such a button. A removed button is convention;
-- a revoked grant is enforcement.
--
-- So: `parts`, `engines`, `engine_models` lose INSERT for the app roles.
--   • fn_receive_stock still creates them — SECURITY DEFINER runs as the
--     function owner, which is not `authenticated`, so the revoke does not
--     apply to it. is_owner() inside the function remains the caller gate.
--   • UPDATE is deliberately KEPT: the catalog stays editable (selling price,
--     margins, reorder level, photo, preferred supplier, fixing a typo'd model
--     name, soft-deleting a discontinued model are all UPDATEs).
--   • service_role is unaffected (test harness seeds fixtures through it).
--
-- Verified by scripts/test-catalog-lock.mjs: a direct PostgREST insert fails
-- FOR THE OWNER, while a receiving with an inline new product succeeds.
-- ---------------------------------------------------------------------------

revoke insert on public.parts from public, anon, authenticated;
revoke insert on public.engines from public, anon, authenticated;
revoke insert on public.engine_models from public, anon, authenticated;

comment on table public.parts is
  'Product catalog (quantity-tracked). NO direct INSERT for app roles since
   0049 — parts are born inside fn_receive_stock (receiving is the single
   stock entry point). UPDATE stays owner-editable via RLS.';
comment on table public.engines is
  'Serialized engines, one row per physical unit. NO direct INSERT for app
   roles since 0049 — serials are born inside fn_receive_stock.';
comment on table public.engine_models is
  'Engine type definitions. NO direct INSERT for app roles since 0049 —
   created inline at receiving; edited/deactivated from Master Inventory.';
