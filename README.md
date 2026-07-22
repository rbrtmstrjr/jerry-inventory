# Gerwin Trading — Multi-Shop Inventory & Approval System

Centralized inventory and sales-approval system for a Philippine marine store
(outboard engines + parts + fisherman goods) supplying multiple branch shops.
The owner holds all inventory centrally, delivers stock to shops, and approves
every sale and loss before stock deducts. Employees record; they never move stock.

## Stack

- **Next.js 16** (App Router) + React 19 + TypeScript
- **Supabase** — Postgres, Auth, Realtime. **Row-Level Security is the access enforcer.**
- Tailwind CSS v4 + shadcn/ui · TanStack Table · Recharts · react-hook-form + zod
- JsBarcode (Code128 labels) · sonner toasts
- Deploy target: Vercel

## Setup

```bash
npm install
cp .env.example .env.local   # fill in your Supabase project values
npm run dev
```

Apply migrations in order (`supabase/migrations/0001…0009`) via the Supabase SQL
editor, CLI, or Management API. They are idempotent.

## Roles

| Role | Access |
|------|--------|
| Owner | Everything: master inventory, costs, deliveries, approvals, reports, settings |
| Employee | ONE shop only: shop stock (selling price only — cost is physically unreachable), record sales/losses, own submissions |

Money is stored as **integer centavos** everywhere. All stock changes flow
through SECURITY DEFINER Postgres functions (atomic, append-only ledger).

## Key flows

1. **Receive** (supplier → master) → `fn_receive_stock`
2. **Deliver** (master → shop, auto-lands) → `fn_deliver_stock` + delivery-note PDF
3. **Record** (employee, PENDING) → `fn_record_sale` / `fn_record_loss`
4. **Approve** (owner) → `fn_approve_sale` / `fn_approve_loss` — deducts stock,
   auto-creates engine warranties, blocks negative stock. Queue is Realtime-live.
5. **Monthly count** → snapshot → count sheet (blind option) → shortages become
   reason-coded losses in the same approval queue.

## Verification scripts (`scripts/`)

Each deliverable ships with a live test suite (run against the real project):

```bash
node scripts/test-rls.mjs            # RLS isolation proof (35 checks)
node scripts/test-receiving.mjs      # receiving + ledger + barcodes
node scripts/test-deliveries.mjs     # deliveries/returns + guards
node scripts/test-shop-recording.mjs # employee recording rules
node scripts/test-approvals.mjs      # approve/question/reject + Realtime
node scripts/test-warranties.mjs     # warranties, claims, fitment
node scripts/test-reports.mjs        # report aggregates (needs dev server)
node scripts/test-counts.mjs         # monthly count cycle
node scripts/test-admin.mjs          # settings, shops, employee lifecycle
node scripts/smoke-login.mjs         # role routing (needs dev server)
```

## Branding

Every color/radius/theme token lives in **`app/theme.css`** (light + dark).
Rebranding = editing that one file. Chart colors are colorblind-validated —
re-run the dataviz palette validator if you change them.

## Notes

- `.env.local` contains a `SUPABASE_SERVICE_ROLE_KEY` (server-only; used for
  employee account management). Never expose it client-side.
- The admin login is `robertmaestro09@gmail.com`; shop accounts are managed
  from Shops & Employees. Test suites sign in as the admin via `scripts/_harness.mjs`.
