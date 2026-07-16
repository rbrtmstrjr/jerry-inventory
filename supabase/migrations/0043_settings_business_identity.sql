-- ---------------------------------------------------------------------------
-- 0043 — Settings overhaul: business identity + a safe view for documents
--
-- Two jobs, and the second is the load-bearing one.
--
-- 1. ADD what is genuinely new: business_email, business_tin.
--
--    Deliberately NOT added: business_address / business_contact. `address` and
--    `phone` have existed on this table since 0001 and are ALREADY read by the
--    receipt, delivery note, warranty certificate and payslip. Adding a second
--    pair under new names would leave two columns holding the same fact, with
--    the documents reading the old ones — the drift this schema avoids
--    everywhere else (balances are computed, COGS is frozen, shop_id is derived).
--    One fact, one column.
--
-- 2. FIX the reason document headers are wrong today.
--
--    `settings` is owner-only (0002 owner_all loop, asserted by
--    test-admin.mjs "employee cannot read settings"). But two documents an
--    EMPLOYEE legitimately prints read it directly:
--      • /receipt/[saleId]        — the buyer's copy, printed after every sale
--      • /shop/warranties/[id]/certificate
--    For a shop both reads return NULL, so the page silently falls back to a
--    hardcoded 'Jerry's Marine' with no address, no phone and no footer. The
--    owner never sees this: their own reprint of the SAME sale renders fully.
--    So `receipt_footer` is dead on the surface that prints most receipts, and
--    the shop certificate breaks the "byte-for-byte the same paper" promise it
--    documents in its own header.
--
--    The fix is this file's `public_settings` view — the same shape the rest of
--    the schema already uses to solve exactly this (shop_stock, shop_engines,
--    shop_warranties): a security_barrier view exposing ONLY the columns that
--    are already printed on paper handed to customers, and nothing else.
--
--    What it deliberately does NOT expose: default_warranty_months,
--    warranty_expiry_alert_days, supplier_limit_warn_pct,
--    payroll_working_days_per_month, contribution_split_semimonthly. Those are
--    the owner's operating dials, not business identity, and a shop has no
--    reason to read them.
-- ---------------------------------------------------------------------------

alter table public.settings
  add column if not exists business_email text,
  add column if not exists business_tin text;

comment on column public.settings.business_email is
  'Business email printed on documents. Identity, not an auth credential — the
   owner''s login email lives in auth.users and is changed from Settings → Account.';
comment on column public.settings.business_tin is
  'BIR Taxpayer Identification Number, printed on the receipt.';

-- ---------------------------------------------------------------------------
-- public_settings — business identity, readable by any signed-in user.
--
-- No is_owner() predicate on purpose: unlike shop_stock (which scopes rows to
-- the caller's shop), there is exactly one settings row and every column here
-- is already on paper the shop hands the customer. Scoping would be theatre.
-- The security work is the column list, not a row filter.
--
-- security_barrier so a user-supplied function in a WHERE clause can't be
-- pushed down ahead of the view to probe the base table.
-- ---------------------------------------------------------------------------
create or replace view public.public_settings
with (security_barrier = true) as
select
  s.id,
  s.business_name,
  s.address,
  s.phone,
  s.business_email,
  s.business_tin,
  s.receipt_footer
from public.settings s
where s.id = 1;

comment on view public.public_settings is
  'Business identity for printed documents (receipt, delivery note, warranty
   certificate, payslip, count sheet, purchase list). Readable by owner AND
   shop logins — every column here is already printed on paper given to
   customers. Operating thresholds and payroll dials are NOT exposed; read
   those from `settings`, which stays owner-only.';

revoke all on public.public_settings from anon;
grant select on public.public_settings to authenticated;
