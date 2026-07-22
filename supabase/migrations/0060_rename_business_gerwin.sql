-- ---------------------------------------------------------------------------
-- 0060 — business renamed "Jerry's Marine" → "Gerwin Trading"
--
-- The business name printed on every document (receipt, warranty certificate,
-- delivery note, count sheet, stock card, payslip) is read from
-- settings.business_name via public_settings — NOT from code. The hardcoded
-- FALLBACK in lib/business-identity.ts and the brand chrome (sidebar, login,
-- manifest, metadata) are updated in the same change; this migration moves the
-- one value the documents actually read.
--
-- Guarded on the old value (same discipline as 0036's rename): if the owner has
-- since set a custom business name, we leave it alone — this only flips the row
-- that still carries the previous default.
-- ---------------------------------------------------------------------------

update public.settings
   set business_name = 'Gerwin Trading'
 where id = 1
   and business_name = 'Jerry''s Marine';
