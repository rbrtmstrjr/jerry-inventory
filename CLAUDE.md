@AGENTS.md

# Gerwin Trading — Inventory & Sales-Approval System

A centralized, web-based inventory + sales-approval platform for a Philippine
marine store (outboard engines, parts, fisherman goods) supplying multiple
branch shops. The owner (Admin) holds all stock centrally, delivers to shops,
and approves every sale/loss before stock deducts. Employees **record** activity
but can never move stock themselves.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16.2.10 (App Router, Turbopack), React 19, TypeScript 5 |
| Styling | Tailwind CSS v4, shadcn/ui (Radix primitives), `next-themes` (light/dark) |
| Backend | Supabase — Postgres, Auth, Realtime, Storage |
| Security | Postgres Row-Level Security (RLS) as the access enforcer; all stock/state mutations run through `SECURITY DEFINER` functions |
| Data/UI | TanStack Table (data grids), Recharts (charts), react-hook-form + Zod (forms/validation), sonner (toasts) |
| Maps | Leaflet + OpenStreetMap (shop location pins) |
| Barcodes | JSBarcode (Code128 label printing) |
| Hosting | Vercel (project `maccky-marine-inventory`); Supabase project `pruhoaqaurhzyvwwnjdk` (ap-southeast-1) |

**Conventions**
- Money is stored as integer **centavos** (bigint); helpers in `lib/format.ts` (`formatCentavos`, `parsePesosToCentavos`).
- **Soft-delete everywhere** (`deleted_at` column) — nothing is hard-deleted.
- `stock_movements` is an **append-only ledger**; stock is never mutated directly, only via definer functions.
- Business dates are computed in Philippine time (`lib/ph-date.ts`).

---

## Architecture

### Route groups & access model
The `app/` directory uses three route groups, each with its own layout and role gate:

- **`app/(auth)/`** — unauthenticated (login).
- **`app/(owner)/`** — owner-only pages; layout redirects non-owners.
- **`app/(shop)/`** — employee (shop) pages; layout redirects non-employees.

Two routes sit outside all three on purpose: `app/receipt/[saleId]` (both roles
print it; RLS is the gate) and `app/auth/*` (password recovery has to work for
someone who cannot sign in — `proxy.ts` lets `/auth/*` through unauthenticated).

`app/page.tsx` is a role-aware redirect: unauthenticated → `/login`, owner →
`/dashboard`, employee → `/shop`. Auth/session handled by `lib/supabase/*`
(`client`, `server`, `proxy` middleware, `admin` service-role) and `lib/auth.ts`.

### Roles
- **Owner** — one account; full control of inventory, deliveries, approvals, payroll, expenses, settings.
- **Employee (shop)** — **one shared login per shop**. Records sales/losses and edits product photos for its own shop only. Helpers/cashiers are tracked as payroll *staff* records (people without app logins), separate from the shop login.

### Core data flow — the approval pipeline
1. **Receive** stock into master inventory (owner).
2. **Deliver** stock from master to a shop (owner). Stock leaves master into
   **in-transit** and does **not** auto-land — the shop must confirm arrival
   (see "Delivery confirmation" below).
3. Shop **records** sales, losses, and (since 0051) **its own expenses** — these save as status `recorded` and are **invisible to the owner**. An expense is a claim that cash left with no stock footprint, so unlike utang payments it gets the preventive control: the RPC forces `scope='shop'` at the caller's own shop, and nothing counts until approval.
4. Shop **submits a batch** ("Submit to Admin") — all recorded sales, losses, and expenses flip to `pending` under one `submission_batch`. (Utang payments are **not** part of this — see 7.)
5. Owner **reviews the batch as one unit** in the Approval Queue: one-click **Approve all**, or per-item Approve / Question / Reject. Stock deducts **only on approval**; questioned items are skipped and resolved individually.
6. Approving an **engine** sale marks the serial sold and auto-creates its **warranty**.
7. **Utang (receivables):** a partial-payment sale requires a customer and leaves a balance. Later payments are recorded by the shop and **post immediately** — collecting money the customer already owes is bookkeeping, not a stock decision, so it does **not** enter the Approval Queue. The owner is alerted per payment and sees the full history (who/when, voids included) on Receivables. Balance 0 sets `settled_at`; a mistaken payment is **voided** (soft-deleted → balance restored, entry kept). Control here is detective (alert + audit trail), not preventive.

Submission statuses: `recorded → pending → questioned → approved / rejected`.

### Security model (enforced in the database, not just the UI)
- Employees reach shop stock **only through the safe views** `shop_stock` / `shop_engines`, which hide **cost prices** and scope every row to the caller's own shop.
- Base tables (`parts`, `engines`, `stock_levels`, receivings, deliveries, etc.) are **owner-only** via RLS.
- All stock mutations, approvals, batch submit/approve, counts, and image writes go through `SECURITY DEFINER` RPC functions that re-check the caller's role/shop server-side.
- Storage: `product-images` bucket is public-read, writes scoped to owner + the item's own shop; `receipts` bucket is private (owner-only).

---

## Page Inventory (billable pages)

**44 distinct routes** (+6 redirect stubs). `[id]`/`[entryId]`/`[saleId]` are dynamic detail routes. "Print" pages are standalone print-optimized documents.

**The sidebar reads like the business works** (IA reorg, 2026-07): OVERVIEW →
INVENTORY in stock-flow order (Suppliers → Master Inventory → Deliveries →
Stock Alerts → Monthly Count → Movements) → SALES & SERVICE → ADMINISTRATION.
Five routes moved/retired and left stubs (same pattern as `/delivery-requests`):
`/master-inventory/suppliers` → `/suppliers?tab=directory` ·
`/suppliers/payables` → `/suppliers?tab=payables` ·
`/shops/reports` → `/reports?tab=shops` (forwards its query string) ·
`/master-inventory/bulk-add` → `/suppliers?tab=receiving` (Bulk Add retired by
0048 — bulk entry lives inside Receiving) ·
`/master-inventory/receiving` → `/suppliers?tab=receiving` (receiving is a
supplier transaction; this one is a **next.config redirect** and returns a
REAL 307, unlike the page-level stubs which Next 16 serves as 200 +
meta-refresh — `?view=<id>` passes through).

### Authentication & routing (4)
| Route | Page | Purpose |
|-------|------|---------|
| `/login` | Sign in | Email/password login, role routing, **Forgot password?** dialog |
| `/` | Root redirect | Sends user to the correct home by role (no UI) |
| `/auth/callback` | Recovery callback | Route handler: exchanges the emailed PKCE `code` for a session, then redirects. Rejects a non-relative `next` (open redirect). No UI |
| `/auth/reset` | Set a new password | Where a reset link lands. Outside every route group — recovery must work for someone who cannot sign in |

### Owner — Overview (2)
| Route | Page | Purpose |
|-------|------|---------|
| `/dashboard` | Dashboard | KPIs, charts, live snapshot of the whole business |
| `/reports` | Reports | Three tabs (`?tab=`): **Sales & Inventory** (sales/loss/top-parts, date filters, CSV) · **P&L / Net Income** (consolidated statement, cost-vs-selling, cash-vs-accrual, CSV + print) · **Per-Shop Profitability** (moved in from /shops/reports — same body, same `lib/pnl.ts`) |

### Owner — Suppliers (1)
| Route | Page | Purpose |
|-------|------|---------|
| `/suppliers` | Suppliers | Four tabs (`?tab=`) — **order it · receive it · owe it · compare it**: **Directory** (supplier records, credit limits, terms, outstanding inline) · **Receiving** (moved unchanged from /master-inventory/receiving — **the single entry point for stock**: supplier required with live outstanding/utilisation, lines existing-or-inline-new (bulk grid, serial per engine, last-paid context), payment paid/partial/unpaid with due-date presets where the picked date is stored, atomic `fn_receive_stock`, post-save print-labels; `?view=<id>` deep-links a receiving's detail) · **Payables** (what Admin owes: aging buckets, per-receiving balances, Record Payment targeted/FIFO, private receipts) · **Price Comparison** (per product × supplier, always-visible side-by-side, cheapest-first. **Automatic-only** — prices come from receivings (last-PAID); the owner-entered **quote UI was removed** (Record-quote button, per-product quote buttons, Has-quotes/Stale-only filters all gone) at the owner's request: a product appears here purely once it's been RECEIVED from 2+ suppliers, compared by what was actually paid. Every price still carries source + date; **comparable-only always** (2+ suppliers — single-supplier products are never shown, since a real catalog could be thousands); newest product first (by catalog creation ts); "Preferred is ₱X more" badge; **★ Make preferred** per row; a same-SKU/name **duplicate nudge** opens the merge dialog prefilled. NOTE: the `supplier_quotes` table + `recordSupplierQuote` action + quote arm of `supplier_price_comparison` still exist in the DB/backend — only the UI was dropped, so re-enabling is UI-only. Merged duplicates roll up to one product via 0052) |

### Owner — Master Inventory (2)
| Route | Page | Purpose |
|-------|------|---------|
| `/master-inventory` | Products | **View + edit only** — the catalog you look at; products land here because a supplier delivered them. Browse (cards/table, photos, filters), edit existing (selling price, engine margins, reorder, category, photo, notes), per-product **Suppliers & Prices** (provenance-labelled, cheapest marked, preferred changeable inline), reference-data maintenance (rename/retire engine models from the Engines view — type definitions, not stock; **product categories moved to their own Category tab**, 0059-era), and **Merge duplicates** (0052: fold same-SKU/name parts into one survivor — catalog-identity only, refused while the duplicate holds stock/transit/open lines). **Add product / Add engine** (0059): custom catalog + opening stock (qty 0 allowed) with owner cost + selling price (> cost), category, and a **supplier dropdown incl. "No supplier"** (attribution → preferred supplier only, never debt). Both go through `fn_receive_stock` with `p_supplier_id = NULL` (0049 lockdown intact — no direct INSERT); real purchases-with-debt still use Suppliers → Receiving |
| `/master-inventory/categories` | Category | Manage **product** categories (0059-era) — create (the piece the old rename/retire modal lacked), rename, retire, with a live-usage count per category. Owner-only writes (`createCategory`/`updateCategory`/`softDeleteCategory`, re-checked via `getProfile`; case-insensitive dedupe — an active match is refused, a retired one is restored). A new category flows to every product picker/filter via revalidation. Tab order: Products · Category · Labels. Engine-model reference data stays on the Engines view |
| `/master-inventory/labels` | Print Labels | Generate/print Code128 barcode labels (`?ids=` preselects, e.g. straight from a receiving's new products) |

**Receiving is the single stock entry point** — a product enters the system
because a supplier delivered it. There is no create-then-stock two-step and no
supplier-less initial stock: inline product creation + stocking + debt happen
in ONE `fn_receive_stock` transaction (half-saved = impossible).

**NAMED INVARIANT (0049, enforced in the database):** `parts` / `engines` /
`engine_models` have **no direct INSERT grant** for app roles — creation is
only possible inside `fn_receive_stock` (SECURITY DEFINER; the revoke doesn't
apply to it). UPDATE stays granted (catalog editing, soft-delete). A removed
button is convention; a revoked grant is enforcement — a re-added "Add Part"
dialog breaks at the database, not silently in production
(`test-catalog-lock.mjs` proves it, including that the OWNER's own PostgREST
session is refused). Test fixtures seed catalog rows via the service role.

### Owner — Deliveries (2)
| Route | Page | Purpose |
|-------|------|---------|
| `/deliveries` | Deliveries & Returns | One page, three tabs: **New Delivery** (into transit) · **In Transit** (+ the **discrepancy queue** → return to master or transit write-off) · **Transfers & Returns** (0054/0065: shop-to-shop transfer requests AND shop→master **return requests** — Approve/Reject with note; the New Return tab was retired, returns are now shop-initiated + admin-approved. Also the transfer in-transit list + discrepancy queue offering **Return to source shop** / write-off; Print slip). Shop stock-requests moved to **Stock Alerts** (a request is a stock-alert signal, not a movement); `?request=<id>` still pre-fills the New Delivery form — that's how "Convert to delivery" from Stock Alerts lands here. `?tab=` deep-links a tab |
| `/deliveries/[id]/note` | Delivery Note | Printable delivery note document — also the **outgoing** (admin→shop) document for a fulfilled stock request. Prints per-line **cost + selling price** and **Total at cost / at selling** (0064), read LIVE from master. Qty reflects what LANDED once confirmed (`qty_received`), the sent qty before that. The SHOP has its own copy at `/shop/deliveries/[id]/note` (reads the shop-safe views incl. cost/price — 0064 widened the delivery-lines view, extending the 0053 cost narrowing) with a "Delivery note" button on each incoming-delivery card; transfers keep their Stock Transfer Slip instead |

### Owner — Stock Alerts (2)
| Route | Page | Purpose |
|-------|------|---------|
| `/stock-alerts` | Stock Alerts | Four tabs: Master low stock (→ buy from supplier) · All-shops low stock (→ deliver) · **Requests** (shops' stock requests, moved here from Deliveries — badge = open count; **Print request** → the ingoing receipt; **Convert to delivery** navigates to `/deliveries?request=<id>`, which auto-fills EVERY requested line (parts + engines) split two ways per section — **Available in master** (editable, qty capped to on-hand, with a "requested N, only M available" caption) on top, **No master stock** (disabled, informational — never enters the deliver payload) below; Deliver is disabled when nothing is available. The split is a pure `lib/request-fulfillment.ts#classifyRequestLines` (unit-tested); **Dismiss** with a reason) · Reorder levels + per-shop overrides. `?tab=requests` deep-links (delivery-request notifications point here) |
| `/stock-alerts/request/[id]/receipt` | Stock Request Receipt | Printable **ingoing** (shop→admin) document — the full itemized list of a shop's requested stock (parts + engines, qty each) with signature lines, for the admin's records. Owner route (reads owner-only `parts`/`engine_models`). The outgoing counterpart is the Delivery Note |
| `/stock-alerts/purchase-list` | Purchase List | Printable supplier order sheet, grouped by supplier, with suggested order qty. A **supplier dropdown** on the Stock Alerts → Master tab (beside the search, default "All suppliers") filters that list AND drives the Print link's `?supplier=<id>`, so the sheet narrows to one supplier (letterhead + sign-off intact) and each supplier gets its own order; "All" prints the combined sheet |

`/delivery-requests` is now a **redirect** to `/stock-alerts?tab=requests` (kept
so old bookmarks don't 404) — delivery requests live as a tab on **Stock Alerts**
(a request is a stock-alert signal); converting one navigates to
`/deliveries?request=<id>` which pre-fills the New Delivery form.


### Owner — Monthly Count (3)
| Route | Page | Purpose |
|-------|------|---------|
| `/counts` | Monthly Count | List of physical-count sessions |
| `/counts/[id]` | Count Entry | Enter/reconcile counted quantities vs system |
| `/counts/[id]/sheet` | Count Sheet | Printable blank/working count sheet |

### Owner — Movements (2)
| Route | Page | Purpose |
|-------|------|---------|
| `/movements` | Movements | The `stock_movements` ledger as a **book**, three tabs (`?tab=`): **Journal** (every movement, filtered by location/type/product/actor/date/search, server-side paginated, each row deep-linked to its source document) · **Stock Card** (`?tab=ledger`) per product × location with Opening → running → Closing balance · **Engine History** (`?tab=engines`) scan-a-serial chain of custody |
| `/movements/stock-card/print` | Stock Card | Printable bin card (params: `part`, `shop`, `from`, `to`) with the Settings letterhead + signature line |

### Owner — Sales & Service (6)
| Route | Page | Purpose |
|-------|------|---------|
| `/approvals` | Approval Queue | **(a)** Pending: review shop submission batches (sales + losses), one-click Approve-all + per-item actions, live updates. **(b)** Reviewed History: every decided sale/loss/utang payment, filterable (shop · type · status · date · search) with server-side pagination; click a row for a deep-linked slide-over detail (`?item=<type>:<id>`) |
| `/receivables` | Receivables | All unpaid balances across shops — totals per shop/customer, filters, CSV export, per-sale payment history (incl. voided) |
| `/warranties` | Warranties & Serials | Engine serial registry + warranty tracking across all shops; shop filter + selling-shop column; claims |
| `/warranties/[id]/certificate` | Warranty Certificate | Printable warranty certificate |
| `/suki-cards` | Suki Cards | Loyalty discount cards (0072): issue per customer (existing or inline-new), deactivate/reactivate, reissue (new `SC` number), per-card usage (uses + Σ program discount). Rates shown from the Settings dials |
| `/suki-cards/[id]/print` | Suki Card (print) | The physical card — CR80 85.6×54 mm via a route-scoped `@page`, Code128 of the card no (shops' scanners read it), customer name + live terms. Print on cardstock, laminate |

### Owner — Shops & Employees (2)
| Route | Page | Purpose |
|-------|------|---------|
| `/shops` | Shops & Employees | Purely operational since the IA reorg: manage shops (map pins, credentials, close-shop), 2-col cards. Per-branch profitability lives at `/reports?tab=shops`. Shop **color picker** (0050): palette swatches previewing the actual badge, taken colors disabled with the owning shop named, live preview; the shop's color drives its card tile, map pin, chart series, and every `<ShopBadge>` across the app. Shop **logo** (0057): optional per-branch image (reuses the product-image upload pipeline → `product-images` bucket) printed on that branch's receipts + warranty certificates in place of the anchor |
| `/shops/[id]/stock` | Shop Stock | View a single shop's on-hand stock |

### Owner — Payroll (6)
| Route | Page | Purpose |
|-------|------|---------|
| `/payroll` | Run Payroll | Payroll dashboard / run a pay period |
| `/payroll/[id]` | Pay Period | Detail of one pay period and its entries |
| `/payroll/staff` | Staff | Manage staff records (people, not app logins) |
| `/payroll/positions` | Positions | Job positions / rates |
| `/payroll/advances` | Advances | Vale / cash-advance ledger (0071): give a vale, per-staffer outstanding balances, history + void. Deducted per-period on the pay-period detail |
| `/payroll/reports` | Payroll Reports | Payroll summaries with export |
| `/payroll/payslip/[entryId]` | Payslip | Printable individual payslip |

### Owner — Expenses (3)
| Route | Page | Purpose |
|-------|------|---------|
| `/expenses` | Expenses | Operating-expense log with private receipt uploads |
| `/expenses/categories` | Expense Categories | Manage expense categories |
| `/expenses/reports` | Expense Reports | Expense summaries with export |

### Owner — Administration (1)
| Route | Page | Purpose |
|-------|------|---------|
| `/settings` | Settings | Six sections (`?tab=`): **Business** (identity printed on all six documents + defaults) · **Account** (change password/email behind a current-password re-auth gate, reset email) · **Alerts** (`warranty_expiry_alert_days`, `supplier_limit_warn_pct`, `quote_stale_days`) · **Payroll** (working days, semi-monthly split, the contribution rate book) · **Notifications** (channel status, read-only) · **System** (pg_cron health, connection badges — no secrets) |

### Shop / Employee (10)
| Route | Page | Purpose |
|-------|------|---------|
| `/shop` | My Shop Stock | Shop's on-hand stock + today's sales KPIs; edit own product photos |
| `/shop/warranties` | Warranties | Warranties for engines THIS shop sold; serial lookup (scan-friendly), status + near-expiry highlighting. **File a warranty claim** (0070): repair / replace (pick an on-hand engine) / refund → `fn_request_warranty_claim`, waits for Admin approval; a **My claims** list shows status + Cancel while requested. No edit/void/extend |
| `/shop/warranties/[id]/certificate` | Warranty Certificate | Same document as the owner's, reprintable; ownership re-checked server-side |
| `/shop/warranty-preview/[saleId]` | Warranty Certificate (point-of-sale) | 0055: the **customer's** warranty copy, printable the moment an engine sale is recorded — **before** Admin approval (the official warranty row only exists post-approval). One full-page certificate per engine on the sale, rendered by the guarded definer `fn_shop_warranty_preview` (terms via engine → model → settings fallback, `sold_on` = sale date). NOT thermal — a separate coupon-printer document. Never auto-prints (only the thermal receipt does); reached from the Submissions row. 404s for a cancelled sale, so it voids with the receipt |
| `/shop/deliveries` | Incoming Deliveries | Count + confirm what actually arrived (no reject/return — a shortfall goes to Admin); history |
| `/shop/low-stock` | Low Stock | This shop's items at/below their effective threshold → Request delivery from Admin; own request history |
| `/shop/record-sale` | Record Sale | Scan/browse cart, cash/change helper; since 0053 EVERY line (part + engine) shows its own-shop **cost** (read-only, the tawad floor) and an editable selling price defaulting to catalog — server rejects any price at/below cost; partial payment (customer required); a **payment-method** picker (cash/gcash/bank/other, 0061 — the change helper shows only for cash) saved on the sale; saves as `recorded`. A **"Print receipt on save"** checkbox (default ON, sticky per-browser via `localStorage jm-sale-autoprint`) prints the 58mm receipt **in-place** on save — an off-screen iframe loads `/receipt/[id]` and fires its own print dialog, so the cashier never leaves the page (with a kiosk-printing default printer it prints with no dialog). Unchecked = no auto-print; reprint any sale from its Submissions row |
| `/shop/record-loss` | Record Loss | Reason-tagged write-off request; saves as `recorded` |
| `/shop/receivables` | Receivables (Utang) | This shop's outstanding balances + Record Payment (posts immediately) + payment history with void |
| `/shop/expenses` | Expenses | Record this shop's expenses (category or propose-new, optional receipt photo) — saves as `recorded`, rides the submission batch, **counts only when approved**; list shows own submissions with statuses + Admin-recorded entries for this shop; company expenses invisible |
| `/shop/transfers` | Transfers | Three tabs: **Send stock** to another branch (0054: destination + lines from own stock → `fn_request_transfer`) · **Return to Admin** (0065: shop→master **return request** — reason + parts good/damaged + engine condition → `fn_request_return`; own-returns list with status + Cancel while requested + Admin's reject note) · **Sent** (outgoing transfers, Admin note on reject, Cancel while Requested, Print slip once approved). Incoming transfers appear on `/shop/deliveries` (labelled with the source) |
| `/shop/submissions` | Submissions | Current report (unsent) → Submit batch to Admin; Submitted / Reviewed tabs. Every sale row carries a **print-receipt** action (→ `/receipt/[id]`) — the reprint path when Record Sale's auto-print is off, across Current/Submitted/Reviewed. An engine sale row also gets a **Print warranty** action (→ `/shop/warranty-preview/[saleId]`, the full-page **coupon-printer** certificate, never thermal) that appears **the moment the sale is recorded — no Admin approval needed** (it's a customer document, not the control record). Both documents **void with the sale**: cancelling it (`cancelSale`) makes the receipt AND the warranty route 404, since both read the sale with `deleted_at is null`. This is the shop's first place to reach the warranty; the read-only `/shop/warranties` page (populated only on approval) is the second |

### Shared documents (3)
| Route | Page | Purpose |
|-------|------|---------|
| `/receipt/[saleId]` | Receipt | Printable sale receipt, rendered from the recorded sale — same numbers by construction. RLS-scoped to owner + selling shop. **58mm thermal layout** (single column, monochrome text letterhead, dashed rules) via a **route-scoped** `@page { size: 58mm auto }` + CSS in an inline `<style>` — must stay on this route only (never in globals.css/theme.css) so it can't leak into the other full-page printables; the doc HTTP suite asserts the `58mm` marker is present here and absent everywhere else. Below the business letterhead (same for all branches) it prints the **branch line** — `Branch: <shop>` + the shop's `location` (0056) — so a customer can tell which branch issued it. Above the letterhead it shows the branch **logo** (`shops.logo_path`, 0057), falling back to the anchor icon. Prints the **payment method** (0061) as `Paid via <method>` (`Downpayment via <method>` when partial). |
| `/transfer/[id]/slip` | Stock Transfer Slip | Printable slip that travels with a shop-to-shop transfer (0054), signed on both ends. Party-scoped via `transfer_slip` — readable by owner, source, and destination; a non-party gets `notFound()`. Shows From → To, lines (+ engine serials), and received qty + shortfall after confirmation. |
| `/return/[id]/slip` | Return Slip | Printable slip that travels with a shop→master return (0066), signed on both ends. Party-scoped via `return_slip` — readable by owner + the returning shop only; a non-party (or anon) gets `notFound()`. Shows Returned by → Admin/Master, lines split **Good / Damaged** (+ engine serials), reason, status, and the Admin note when rejected. "Print slip" sits on every return card (shop side, from `requested` onward; owner side, on each pending request). No cost columns. |

**Feature summary for billing:** ~15 functional modules — Auth (+ password
recovery), Dashboard, Reports (+ consolidated P&L / Net Income), Master
Inventory (+Receiving as the single stock entry point/Labels/Suppliers), Deliveries & Returns, Monthly
Count, Movements (journal · stock card · engine chain of custody), Approval
Queue, Warranties, Shops & Employees, Payroll, Expenses, Receivables/Utang,
Stock Alerts (+ Delivery Requests, a tab on Deliveries), Suppliers (directory ·
payables · price comparison with provenance-labelled quotes),
Settings (6 sections incl. credential change + system health), and the 7-page
Shop app (incl. shop-recorded expenses riding the approval batch). Plus 7 printable documents (delivery note, count sheet, warranty
certificate, payslip, sale receipt, supplier purchase list, stock card) and
cross-cutting systems (image pipeline, maps, barcodes, realtime approvals,
unified negotiable pricing (one selling price per product, editable at sale,
server-floored strictly above the shop-visible cost) + partial payment, a
receivables/payments ledger with void + audit trail, supplier debt with credit
limits + audited overrides, and channel-agnostic in-app notifications).

### Two ledgers, opposite directions — don't conflate them
**Receivables** = what customers owe *us* (`utang_payments`).
**Payables** = what *we* owe suppliers (`supplier_payments`).

Supplier payments are stock **cost (COGS)** and must never also be entered in
the Expenses module (fuel/labour/rent) — double-counting there would overstate
expenses and understate margin. `test-supplier-payables.mjs` asserts supplier
payments never appear in `expenses`.

### Government contributions — rates are DATA, never code
SSS · PhilHealth · Pag-IBIG. The employee share is withheld automatically
(`net_pay = gross_pay − Σ employee shares`, and **nothing else** — no tax, loans,
advances, overtime or 13th month). The employer share is an employer cost and
**never** reduces net.

**Never hardcode a rate, bracket, MSC, floor or ceiling.** They live in
`contribution_brackets`, effective-dated and owner-editable from Settings, so a
new circular is a data edit rather than a redeploy. `test-payroll-contributions.mjs`
greps app code for rate literals and fails if one appears.

Three shapes, because the agencies genuinely differ:
- **SSS** is a bracket→**MSC lookup**, not a percent of pay: the 5%/10% apply to
  `credited_salary_centavos`, so a raise inside a bracket changes nothing.
  `er_extra_centavos` carries the employer-only EC. 61 brackets; the seed
  self-checks against the published anchors and fails the migration if it drifts.
- **PhilHealth / Pag-IBIG** are `percent_of_salary` with the basis clamped to
  `basis_floor_centavos`/`basis_ceiling_centavos` first (PhilHealth's floor and
  ceiling; Pag-IBIG's Maximum Fund Salary).
- `fixed` exists for a future circular that is neither.

An exclusion constraint (`contribution_brackets_no_overlap`) means an
agency+date+salary resolves to **exactly one** row — ambiguity is impossible by
construction, not by convention.

**The basis is the RATE, never days worked** (a daily rate is monthly-ised via
`settings.payroll_working_days_per_month`), so a deduction doesn't swing with
attendance. But you cannot withhold from pay that isn't there: gross 0 → no
contributions (also the normal draft state of a daily staffer), and gross below
the total employee share **raises** rather than silently zeroing someone's pay or
under-remitting. Weekly periods carry no contributions — a contribution is a
monthly obligation and no agency defines a weekly split.

`payroll_entry_contributions` is a **frozen snapshot** (amounts + the bracket
used): editing a rate next year must never rewrite last year's payslip. Same
principle as stored tier prices and `sale_line_costs`.

Rounding: percents round **half up** to whole centavos; a semi-monthly
`half_each` split gives the 1st cutoff `floor(total/2)` and the 2nd the
remainder, so the halves always sum to the monthly obligation exactly — the
remittance must tie out to the agency's figure.

Seeds were verified against official sources in July 2026 (SSS Cir-2024-006 ·
RA 11223 · HDMF Circular 460) and are a starting point, not certification.

### Per-shop profitability — what is and isn't a shop's cost
`Revenue (approved sales only) − COGS = Gross Profit`, then
`− shop expenses (scope='shop') − shop payroll = Net Contribution`.
`Σ shop net − company overhead = business net` **contribution — which is not net
income.** See the identity below.

**One implementation: `lib/pnl.ts`.** `/reports?tab=shops` and `/reports?tab=pnl` are
the same numbers from two directions, so they compute them in one place and
import it. Do not re-derive this math anywhere — if the two pages ever disagree,
that is the bug.

#### The identity
```
Σ shop net contribution − company overhead − shrinkage = NET INCOME
```
**The shrinkage term is not optional, and it is where a spec will lie to you.**
A shop's contribution deliberately EXCLUDES losses (a branch is not blamed for
stock that never sold), while the business's net income cannot (a stolen engine
is real money gone). So `Σ shop net − overhead = net income` is arithmetically
FALSE — the two sides differ by exactly the shrinkage. Both rules survive
because the identity carries the term explicitly:
- per shop — contribution, losses shown alongside as context
- business — net income, shrinkage subtracted where it actually lands

Revenue is **accrual**: approved sales count the moment they're approved,
including utang never collected. `computeCashPosition` is the separate answer to
"what actually arrived" (`earned` / `collected` / `outstanding`). Never present
one as the other — a month can earn ₱200k and collect ₱40k.

Three rules hold this together:
- **Company overhead is never allocated.** No percentage split across branches.
  A shop's number shows only what is directly attributable; overhead is
  subtracted once, at the business level. Honest beats clever.
- **COGS is frozen at approval** in `sale_line_costs`, not read live from
  `parts.cost_centavos` — that column is mutable, so a live read would let one
  cost edit silently rewrite past profit. Same idea as `losses.value_centavos`.
- **Losses and transit write-offs stay out of the profit chain.** They're stock
  that never sold, not the cost of what did; the three-way separation
  (transit write-off · shop loss · return) is preserved and shown as context.
- **Labor cost is gross + employer contributions**, not `net_pay`. Net is what
  the staffer took home; the employee share it excludes was still the shop's
  money (it went to the agency, not the pocket), and the employer share is a
  further cost on top of gross. Subtracting net understates every shop.
- **Closed shops still count.** the per-shop report (now /reports?tab=shops) must NOT filter shops to
  `deleted_at is null` — a branch that shut mid-period still sold and still cost
  money in that period, and dropping it understates business net (Roxas Branch
  closed 2026-07-14 holds ~35% of all approved revenue). Closed shops appear
  when they have activity in range, badged `Closed`.

Both balances are **computed, never stored**: a receiving's balance is
`total_amount − Σ(payments)` via `fn_receiving_balance`, so a receiving and its
ledger can't drift apart. Credit limits **warn, never block** — going over
requires an explicit reason, recorded on the receiving
(`limit_override`/`_reason`/`_by`/`_at`). FIFO payments allocate by
`received_at`, not `due_date`: oldest-first means *when the debt was incurred*.

### Delivery confirmation — stock is always in exactly one bucket
**master · in-transit · shop.** Send → master −qty, qty enters in-transit.
Shop confirms what physically arrived → that qty moves in-transit → shop. Any
shortfall **stays in transit** and flags the delivery `discrepancy`. Only the
**owner** resolves it: back to master (found), or a reason-coded **transit
write-off** (lost between master and shop).

> **The shop RECORDS what arrived; the owner DECIDES what happens to anything
> missing.** There is no shop-callable path to reject, return or write off —
> the shop can only enter counts and notes. Confirmation is one-shot and can
> never exceed the sent quantity.

Since 0058 the shop records good / **damaged** / missing per line (damaged as a
distinct outcome, with an optional photo under its own `shop-<id>/` prefix).
Damaged units do NOT land in sellable stock — they stay in `qty_outstanding`
alongside missing (damage is a confirm-time annotation, not a change to the
generated formula) until the OWNER resolves them through the same discrepancy
queue, reason-tagged `damaged` (→ write-off shrinkage / return-to-master → the
supplier) vs `lost_in_transit`. Damage on arrival is business-level shrinkage,
not the receiving shop's fault — same treatment as any transit write-off.

Reconciliation invariant (asserted in `test-delivery-confirm.mjs` after every
step): `sum(stock_levels.qty) + sum(stock_in_transit.qty) = total owned`. Only
a transit write-off may reduce total owned. `stock_in_transit` is a **view**
over `delivery_lines.qty_outstanding` (generated column), so the bucket can
never drift from the line it came from. Reports keep **transit write-offs**
(`movement_type='transit_writeoff'`) separate from **shop losses** (`losses`
table) and **returns** (`return`) — three different things.

### Shop-to-shop transfers — a delivery whose source is a shop (0054)
A **transfer** reuses this exact model: `deliveries.from_shop_id` (NULL =
master, non-null = source shop) generalizes the delivery. The flow: source shop
**requests** (`fn_request_transfer` → status `requested`, no stock moves — shops
record, never move stock) → owner **approves** on the Deliveries → Transfers tab
(`fn_approve_transfer` re-checks the source still holds every line and RAISES
the whole request if it was sold since — same preventive guard as sale approval;
debits source into transit) or **rejects** (note required) → destination
**confirms** arrival with the SAME `fn_confirm_delivery` (count-only; it already
scopes to the destination `shop_id` and needed no change) → owner resolves any
shortfall with `fn_resolve_delivery_discrepancy`, now offering
**returned_to_source** (back to the source shelf) alongside written_off. The
source can `fn_cancel_transfer` only while `requested`. The invariant survives
by construction: the write-off is booked at `shop_id = source`, and the journal
already relocates `transit_writeoff` to the synthetic `transit` location
**shop-agnostically** (0045) while the stock card excludes it by type — so the
source shop's ledger reconciles to its shelf exactly as master does. A transfer
write-off is business-level shrinkage in the P&L (the shrinkage query filters
only on `movement_type`, so it counts write-offs at any `shop_id`) and never
touches a shop's Net Contribution. Shop-facing views: `shop_incoming_deliveries`
(destination, now labelled with the source; hides pre-approval transfers),
`shop_outgoing_transfers` (source tracks what it sent), and party-scoped
`transfer_slip`/`_lines` backing the printable **Stock Transfer Slip**
(`/transfer/[id]/slip`, outside every role group — readable by owner, source,
and destination; a non-party gets no row → `notFound()`). New notification
types: `transfer_requested`/`transfer_approved`/`transfer_rejected`.

### The ledger has no transit location — read before touching `/movements`
`stock_movements.shop_id IS NULL` means **master** everywhere in this schema.
But stock lost between master and shop was in *neither*, and that gap has a
sharp edge:

- `fn_deliver_stock` debits master when stock is **sent** (`delivery −qty`,
  `shop_id NULL`) + `stock_levels` master −qty.
- `fn_resolve_delivery_discrepancy` then books `transit_writeoff −qty`, also at
  `shop_id NULL`, and deliberately writes **nothing** to `stock_levels` — the
  stock already left master and never landed.

So the same units are debited from master **twice in the book, once in
reality**: master's ledger sums to −2 while master's shelf says 0, and a naive
stock card prints a negative running balance.

**`movement_journal` therefore reports `transit_writeoff` at
`location_kind='transit'`, not `master`** — which is where the stock actually
was. It is the ONLY movement type that debits a bucket it never occupied:
`transit_return` stays at master precisely because those units really do land
back on the shelf and really do credit `stock_levels`.

With that one row relocated:
```
Σ movements(product, location) = stock_levels(product, location)   -- master + every shop
```
holds exactly, and `test-movements.mjs` asserts both that it holds **and** that
it breaks by exactly the lost qty if the row is moved back. Consequences:
- `fn_stock_card` excludes `transit_writeoff` — a card is a **bin** card and
  those units never reached a bin. They stay visible in the Journal under
  "In transit" and in the P&L's shrinkage line.
- The invariant is asserted over **live parts only**. The pre-2026-07-10 scripts
  retired fixtures by soft-deleting the part AND dropping its `stock_levels` row
  while leaving movements behind, so ~16 pairs read "ledger 30, shelf 0". That
  is orphaned debris with no shelf left to disagree with — not a discrepancy.
  (~77 of ~269 journal rows are that debris and are visible to the owner.)

**Corrections do not exist.** `movement_type` has a `correction` value with
**zero** rows and no function that can write one; `transfer` is not in the enum
at all. `stock_movements` has no INSERT/UPDATE/DELETE policy for **anyone** —
not even the owner — so the ledger is append-only via definer functions, full
stop. Don't add an edit path; a contra-entry RPC would be a new control
decision, not a reporting one.

### Stock alerts — the core distinction
**Master low → buy from a SUPPLIER** (remedy: the printable purchase list,
grouped by supplier). **Shop low → request a DELIVERY from the owner**
(hub-and-spoke; shops never buy from suppliers). A request is *not* a stock
mutation and never enters the sales Approval Queue — the owner converts it into
the existing delivery flow, which links + fulfils it.

Notifications are raised by one trigger on `stock_movements` (the ledger every
stock path already writes to), so receiving/delivery/return/sale/loss are all
covered by a single hook. Dedupe: at most one **unread** notification per
recipient+type+product+shop, so a still-low item never re-spams. The
`notifications` row is channel-independent; `fn_notify` fans out a
`notification_dispatches` row per enabled channel in `notification_channels`
(`in_app` enabled, `sms` seeded **disabled**). Adding SMS later = enable the
channel and drain pending dispatches — no schema redesign. **SMS is not built.**

---

## Database Schema (Postgres)

**Core inventory:** `shops`, `profiles` (app logins/roles), `suppliers`,
`product_categories`, `engine_models`, `parts` (+`merged_into` tombstone since
0052), `part_fitments`, `part_merges` (merge audit, owner-only), `customers`,
`engines` (serial-tracked), `stock_levels` (per-shop on-hand).

**Movement & transactions:** `receivings`(+`receiving_lines`),
`deliveries`(+`delivery_lines`), `returns`(+`return_lines`),
`sales`(+`sale_lines`), `losses`, `submission_batches`, `utang_payments`
(receivables ledger — customers owe us), `supplier_payments` (payables ledger —
we owe suppliers), `stock_movements` (append-only ledger).

**Service:** `warranties`, `warranty_claims`.

**Counts:** `count_snapshots`(+`count_snapshot_lines`).

**Payroll:** `positions`, `staff` (+ gov IDs, `contributions_enabled`),
`pay_periods`, `payroll_entries`, `contribution_brackets` (the rate book),
`payroll_entry_contributions` (frozen per-entry snapshot).

**Expenses:** `expense_categories` (+`status` `active`|`proposed` +
`proposed_by_shop_id` since 0051 — shop-proposed categories activate only on
approval, or the expense is remapped and the proposal never activates),
`expenses` (scoped since 0013: `scope` `shop`|`company` + `shop_id`, paired by
the `expense_scope_shop` CHECK — shop-scoped needs a shop, company-wide must
not have one; lifecycle since 0051: `status`/`source`/`approved_by`/
`approved_at`/`review_note`/`batch_id`, with `expense_shop_source` CHECK —
shop-sourced is always shop-scoped at the recorder's own shop. Owner-created
rows are born `approved` (he doesn't approve himself); **every report/P&L
query filters `status='approved'`** — a pending claim never inflates costs.
Shops SELECT their own shop's expenses (both sources); company rows are
invisible to them. Receipts: shops write/read the private bucket only under
`shop-<shop_id>/…`).

**COGS:** `sale_line_costs` — unit/line cost frozen at approval, **owner-only**.

**Stock alerts:** `shop_reorder_levels` (per-shop threshold overrides),
`delivery_requests`(+`delivery_request_lines`), `notifications`,
`notification_channels`, `notification_dispatches`.

**Reviewed history:** `reviewed_items` — an owner-only view unioning reviewed
sales + losses + utang payments into one filterable/paginatable list (common
columns: `item_type`, `status`, `event_at`/`event_date` (PH), `amount_centavos`,
`summary`, `search_text`). The list is queried server-side from searchParams on
`/approvals`; detail is fetched per type by `getReviewedDetail()`. Read-only —
it is a view, so nothing there can re-approve or move stock.

**Delivery confirmation:** `deliveries.status`
(`in_transit`→`confirmed`|`discrepancy`→`resolved`), `delivery_lines`
(`qty` = sent, `qty_received`, `qty_resolved`, generated `qty_outstanding`,
`shop_note`), `delivery_discrepancies` (owner's resolution audit trail).
Views: `stock_in_transit`, `shop_incoming_deliveries`,
`shop_incoming_delivery_lines`.

**Config:** `settings` — one row, owner-only. Business identity
(`business_name`, `address`, `phone`, `business_email`, `business_tin`,
`receipt_footer`) + operating dials (`default_warranty_months`,
`warranty_expiry_alert_days`, `supplier_limit_warn_pct`,
`payroll_working_days_per_month`, `contribution_split_semimonthly`). Note
`address`/`phone`, **not** `business_address`/`business_contact` — one fact, one
column.

**Movements ledger (owner-only):** `movement_journal` — the readable book, one
row per `stock_movements` row with the source document, actor and loss `reason`
resolved (`reason` is not a column on the ledger; it lives on the loss).
`fn_stock_card(part, shop, from, to)` returns an opening balance + every
movement with a **running balance** from a window function, ordered
`(created_at, id)`. See "The ledger has no transit location" below.

**Safe views (employee-facing):** `shop_stock`, `shop_engines`,
`receivables` / `shop_receivables`, `shop_low_stock` / `shop_low_stock_safe`,
`shop_warranties`, `public_settings` — scoped to the caller's shop (owner sees
all), `security_barrier`. Since 0053 `shop_stock`/`shop_engines` DO carry
`cost_centavos` (own-shop cost, read-only — the tawad floor); every other cost
surface stays owner-only (see "Cost visibility — narrowed" above).
`public_settings` is the odd one
out: it has no row filter because there is one settings row and every column it
exposes is already printed on paper handed to customers. Its security is the
**column list** — business identity only, never the operating dials. It exists
because `settings` is owner-only, so a shop printing a receipt read null and
handed the customer a nameless, address-less, footer-less document while the
owner's reprint of the same sale looked complete. `shop_warranties` scopes through the **originating
sale** (`warranties.sale_id → sales.shop_id`): a shop sees only engines it sold,
read-only, and cannot look up a serial it didn't sell — not even to learn the
warranty exists. `master_low_stock` is owner-only (guarded by `is_owner()`
inside the view). `receiving_balances` and `supplier_payables` are likewise
owner-only — employees get **zero** access to supplier debt or cost.
Low stock is always **computed** from current levels vs the
effective threshold (`shop_reorder_levels` override ?? product default) —
never a stored flag. Receivable balances are
**computed** (`total − amount_paid_at_sale − Σ approved payments`), never a
mutable running total; `sales.balance_due_centavos` stays the at-sale snapshot
the printed receipt shows.

### Migrations (`supabase/migrations/`, 0001–0072)
`0001` schema · `0002` RLS + safe views · `0003` seed · `0004` receiving fns ·
`0005` delivery fns · `0006` record (sale/loss) fns · `0007` line descriptions ·
`0008` approval engine + realtime · `0009` count fns · `0010`/`0011` product &
engine images · `0012` payroll · `0013` expenses · `0014` shop coordinates ·
`0015` shop-scoped image editing · `0016` `recorded` status · `0017` batch
submissions · `0018` batch approval (`submission_batches`, `fn_approve_batch`) ·
`0019` versioned image paths (cache-proof photo replace) · `0020` engine 3-tier
pricing (margins → computed stored prices via trigger, `shop_engines` exposes
prices/hides cost, sale-line agreed/discount + sale partial-payment/receipt
fields) · `0021` pricing RPCs (`fn_record_sale` hard-floor + partial payment +
receipt no; `fn_receive_stock` accepts margins) · `0022` receivables
(`utang_payments` ledger, `settled_at`, `receivables`/`shop_receivables` views,
RLS + realtime) · `0023` utang payment RPCs (record/approve, batch integration,
customer required on partial sales) · `0024` stock alerts (engine-model reorder
level, `preferred_supplier_id`, `shop_reorder_levels`, `delivery_requests`,
`notifications` + channel/dispatch tables, 3 low-stock views) · `0025` alert
functions (`fn_notify` dispatcher, `fn_check_stock_alerts` + stock_movements
trigger, delivery-request lifecycle, notification read state) · `0026` utang
payments post immediately (supersedes the approval-gated model in `0023`:
`fn_record_utang_payment` posts + alerts the owner, `fn_void_utang_payment`
soft-deletes to restore the balance while keeping history; payments removed
from batch submit/approve) · `0027` transit enums (own migration: a new enum
value can't be used in the tx that adds it) · `0028` delivery confirmation
(status lifecycle, qty_received/qty_outstanding, `stock_in_transit` +
shop-facing views, discrepancies; **backfills the 20 pre-existing deliveries as
`confirmed`** — they already auto-landed) · `0029` transit RPCs
(`fn_deliver_stock` no longer auto-lands, `fn_confirm_delivery`,
`fn_resolve_delivery_discrepancy`) · `0030` `reviewed_items` view (owner-only
unified reviewed history) · `0031` shop warranty visibility (`shop_warranties`
safe view scoped via the originating sale, `settings.warranty_expiry_alert_days`
default 30, `fn_check_warranty_expiry`) · `0032` pg_cron schedule for the daily
expiry check (separate migration — the extension + function must exist first) ·
`0033` supplier payables (supplier `credit_limit`/`payment_terms_days`/
`terms_note`; receiving `total_amount`/`amount_paid`/`payment_status`/`due_date`/
`settled_at` + `limit_override*` audit; `supplier_payments` ledger,
`settings.supplier_limit_warn_pct` default 80, `receiving_balances` +
`supplier_payables` views; **backfills all 7 pre-existing receivings as `paid`**
— history predates the module, so it must create zero phantom debt) · `0034`
payables RPCs (`fn_supplier_outstanding`, `fn_supplier_limit_check`,
`fn_check_supplier_limit_alerts`, `fn_receive_stock` rewritten with payment/due/
override, `fn_record_supplier_payment` FIFO, `fn_check_supplier_overdue`) ·
`0035` pg_cron schedule for the daily overdue sweep · `0036` owner referred to
as "Admin" (business name is "Gerwin Trading" in `settings.business_name`,
renamed from "Jerry's Marine" in 0060;
redefines the 3 functions that bake the name into notification text + rewrites
already-sent rows) · `0037` shop profitability (expense `scope` default
`shop`→`company` — the old default violated its own CHECK when `shop_id` was
omitted; composite `(scope, shop_id, expense_date)` index; COGS snapshot
stamped in `fn_approve_sale`. **No expense backfill on purpose** — scope has
existed since 0013 and the live rows are genuinely shop-scoped, so re-scoping
them to `company` would erase real attribution, the opposite of what the
0028/0033 backfills did) · `0038` moves the COGS snapshot off `sale_lines` into
owner-only `sale_line_costs` — `sale_lines_select` lets employees read their own
shop's lines, so a cost column there leaked cost to shops; column grants can't
fix it (owner and employees are both `authenticated`) · `0039` gov contributions
(`contribution_brackets` + non-overlap exclusion constraint, staff gov IDs +
`contributions_enabled`, `payroll_entry_contributions` snapshot, settings keys,
and **effective-dated seeds for all three agencies** whose SSS block self-checks
against the published anchors) · `0040` contribution RPCs (`fn_contribution_basis`,
`fn_resolve_contribution`, `fn_apply_entry_contributions`, `fn_remittance_totals`;
`fn_create_pay_period`/`fn_save_payroll_days` rewritten to apply them) · `0041`
zero-gross rule — 0040 deducted from every enrolled entry, but `payroll_entries`
has CHECK `net_pay >= 0` and daily staff draft at 0 days, so creating any period
with a daily-rate staffer failed outright · `0042` owner guards on
`fn_resolve_contribution`/`fn_contribution_basis` — both are `SECURITY DEFINER`
(so they bypass RLS) and were callable by employees · `0043` settings business
identity (`business_email`, `business_tin`; `public_settings` safe view).
Deliberately does NOT add `business_address`/`business_contact`: `address` and
`phone` have existed since 0001 and are already read by four documents, so a
second pair would be two columns holding one fact with the documents reading the
old ones · `0044` `fn_cron_job_health` — pg_cron lives outside `public` so
PostgREST cannot read it; returns schedule/last-run/status/`stale`, and
deliberately NOT the job `command` or run message (a scheduled `pg_net` call is
a classic place for a service key) · `0045` movement ledger (composite indexes,
`movement_journal`, `fn_stock_card`) · `0046` supplier price comparison
(`supplier_quotes` XOR part/engine-model + soft-delete + owner RLS;
`settings.quote_stale_days` default 60; `supplier_product_prices_history` —
last-PAID per supplier × product derived from receivings, engines grouped by
MODEL; `supplier_price_comparison` — effective price = fresh quote → last-paid
→ stale quote, always labelled, is_cheapest + preferred delta via windows;
both views `is_owner()`-guarded) · `0047` definer guards on the three balance
functions that shipped after 0042 unguarded (`fn_supplier_outstanding`,
`fn_receiving_balance`, `fn_sale_balance` — guard is `is_owner() OR auth.uid()
IS NULL` so the JWT-less pg_cron sweeps keep working) · `0048` receiving as the
single entry point (`fn_receive_stock` accepts `new_part` on a part line and
`new_model` on an engine line — inline creation + stocking + debt in one
transaction; JM barcode minting (GT since 0062); live (brand, model) reuse; friendly
unique-violation errors; payment/limit/due-date behavior byte-identical to
0034. Bulk Add retired → redirect stub) · `0049` catalog INSERT lockdown
(revokes INSERT on `parts`/`engines`/`engine_models` from app roles — creation
only inside `fn_receive_stock`; UPDATE kept; harness seeds via service role) ·
`0050` shop colors (`shops.color_key` — a PALETTE KEY ('teal', 'amber', …),
never a hex: CHECK restricts to the 10 known keys, partial unique index
(`WHERE deleted_at IS NULL`) makes it unique among live shops and releases it
on close, deterministic backfill by creation order. Tokens live in
app/theme.css (`--shop-<key>` soft + `--shop-<key>-strong`, light + dark
pairs); `lib/shop-colors.ts` holds the keys; `components/shop-badge.tsx`
(`<ShopBadge>` badge/dot/text) is THE way a shop is named on screen — name
always visible, neutral fallback when null, print documents stay text-only) ·
`0051` shop-recorded expenses with approval (expense lifecycle
`status`/`source`/approver fields/`batch_id`, defaults double as the
zero-pending backfill; category proposals as `expense_categories` rows with
`status='proposed'` created inside `fn_record_shop_expense` (case-insensitive
reuse), activated on approve-as-proposed or bypassed by remap;
`fn_approve_expense` mirrors the approve-sale/loss pattern and
`fn_review_submission` gains the `expense` kind for question/reject;
`fn_submit_shop_batch`/`fn_approve_batch` carry expenses as the 4th type;
`reviewed_items` gains a shop-sourced expense arm; receipts-bucket policies
scope shops to `shop-<id>/…` paths) · `0052` part merge + dedup
(`parts.merged_into` tombstone pointer + `part_merges` audit table; the two
0046 comparison views now resolve the CANONICAL part via `coalesce(merged_into,
id)` so duplicate parts bought from two suppliers roll up to one product with
`supplier_count` = distinct suppliers. `fn_merge_parts` is **catalog identity
only — it writes NO ledger row**: a source may be merged only when it carries
zero live stock, nothing in transit, and no open sale/loss line, so retiring it
(soft-delete + drop its zero `stock_levels`) is the already-blessed "orphaned
debris" pattern test-movements excludes — the reconciliation invariant is
untouched. Non-destructive: receiving_lines/quotes/sale_lines stay literally
true on the source; pricing redirects via `merged_into`, enforced one-hop
(target must be canonical). `fn_receive_stock` now REUSES a live, non-merged
part by barcode/SKU before minting a new one — the root-cause fix for split
comparisons; never dedups on name alone. NO hard SKU-unique index (live data
has the dupes — that's the bug); dedup is behavioral) · `0053` unified pricing +
cost visible (retires the engine 3-tier margins entirely — drops
`trg_engines_sync_tier_prices`, `engines_sync_tier_prices()`,
`fn_compute_tier_price`, and the six `engines` tier columns; `price_centavos`
becomes the single selling price. `shop_stock`/`shop_engines` now expose
`cost_centavos` — a DELIBERATE narrowing of "cost is owner-only": a shop sees
the unit cost of its OWN on-hand stock (the tawad floor) and nothing else. Every
OTHER cost surface stays owner-only. `fn_record_sale` makes PARTS negotiable
like engines — every line takes an optional agreed price floored STRICTLY above
the server-read cost (at-cost rejected, +1 centavo OK); the legacy
`p_engine_ids` param is dropped. `fn_receive_stock` drops the engine margin
params and validates a provided selling price > cost. NO hard price>cost table
CHECK (would reject existing at/under-cost rows) — enforced in the RPC + edit
actions) · `0054` shop-to-shop transfers (generalizes `deliveries` with
`from_shop_id` (NULL = master → every existing delivery unchanged), statuses
`requested`/`rejected`/`cancelled`, `requested_by`/`approved_by`/`approved_at`/
`review_note`; `fn_request_transfer` (source records, no movement) +
`fn_approve_transfer` (owner debits source into transit, re-checks stock) +
`fn_cancel_transfer`; `fn_resolve_delivery_discrepancy` extended with
`returned_to_source` and books the write-off at the delivery's `from_shop_id`;
`shop_incoming_deliveries`/`_lines` gain a source label + hide pre-approval
transfers; new `shop_outgoing_transfers`/`_lines` and party-scoped
`transfer_slip`/`_lines`; `fn_stock_card` delivery particular made sign-based
(names the real source/dest); transfer notification types. Reuses `delivery`/
`transit_return`/`transit_writeoff` — NO new movement types; the invariant holds
by construction. See "Shop-to-shop transfers" above) · `0055` point-of-sale
warranty certificate (`fn_shop_warranty_preview` — a guarded, **read-only**
SECURITY DEFINER function returning per-engine certificate data computed from a
sale for the shop to print at the counter BEFORE approval; writes nothing,
creates no warranty row. It exists because `engines` and the
`default_warranty_months` dial are owner-only, so a shop can't assemble the
certificate itself. Terms mirror `fn_approve_sale`'s fallback with `sold_on` =
the sale's business_date; returns zero rows for a deleted sale so the
certificate voids with the receipt. Backs `/shop/warranty-preview/[saleId]`; the
official warranty record is still born only on approval — unchanged) · `0056`
branch identity on customer documents (the business letterhead is one name for
all branches, but a receipt/warranty should say WHICH branch issued it). Adds
the selling shop's `location` to the two shop-facing warranty sources —
`shop_warranties` (append-only column) and `fn_shop_warranty_preview`
(drop+recreate to widen the return) — so the certificate names branch + address
self-contained (like `transfer_slip`'s from/to locations). The Sale Receipt
already fetched `shops(name, location)`; it now PRINTS the branch line. Owner
cert page just embeds `shops.location`. Nothing sensitive — a shop already reads
its own shop row via `shops_select`) · `0057` per-branch logo (`shops.logo_path`
— the owner uploads a logo when creating/editing a shop; it replaces the anchor
on the two customer documents the shop hands out: the **sale receipt** and the
**warranty certificate**. No logo → the anchor stays. Stored in the existing
public `product-images` bucket (`shop-logos/<id>-<ts>.webp`; owner-only writes,
public read — no new bucket/policy). Threaded onto `shop_warranties` +
`fn_shop_warranty_preview` as `shop_logo_path` (like the location), embedded
directly by the owner cert page and the receipt. Scope was a deliberate choice:
the delivery note + transfer slip keep the anchor — they're owner/multi-party
documents with no single issuing shop) · `0058` damage & loss on receipt
(`delivery_lines`/`return_lines` gain `qty_damaged` + `damage_photo_path`,
default 0/NULL so live rows are untouched). **Delivery confirm** (shop) now
records good / **damaged** / missing per line + an optional damage photo:
`fn_confirm_delivery` takes `{qty_received, qty_damaged, damage_photo_path}`,
lands only the GOOD (damaged does NOT land — it stays in `qty_outstanding` with
the missing, since the generated formula is untouched; `qty_damaged` is an
annotation), flips to `discrepancy`, notifies the owner with the good/damaged/
missing split. The photo must sit under the confirming shop's own `shop-<id>/`
prefix (matches the receipts bucket policy). **Returns** (owner) are now
inspected: `fn_return_stock` takes parts `{qty_good, qty_damaged}` + engines
`{engine_id, condition}` — good → master (existing return legs), **damaged →
an owner-created *approved* loss at the shop, valued at cost** (movement `loss`;
engine soft-deleted) — the existing shrinkage path, never master sellable stock.
NO new movement types: a damaged delivery unit resolves through the existing
discrepancy queue as `transit_writeoff` (shrinkage) or `transit_return` (back to
master → supplier), reason-tagged `damaged`/`lost_in_transit` (the UI passes it;
`fn_resolve_delivery_discrepancy` was already reason-aware — unchanged). P&L
totals unchanged: damaged-on-arrival (transit_writeoff) and damaged-on-return
(loss) are both already business-level shrinkage and both already excluded from
any shop's Net Contribution. Transfers benefit automatically (they share
`fn_confirm_delivery`). Both RPCs redefined backward-compatibly — `qty_damaged`
coalesces to 0, parts accept the legacy `{part_id, qty}` — so existing callers
keep working. `test-receipt-damage.mjs` proves the whole path incl. reconciliation
after every step) · `0059` optional supplier on receiving (brings back **Add
product / Add engine** in Master Inventory WITHOUT reversing the 0049 lockdown:
creation still only inside `fn_receive_stock`, no INSERT grant. `p_supplier_id
NULL` → a supplier-less, no-debt receiving: skip all credit/payable/alert logic,
header is settled & zero-value (`total_amount 0`, `payment_status 'paid'`),
catalog created/reused inline + stock + `received` movement as usual (invariant
holds). Supplier present → UNCHANGED (Suppliers → Receiving debt flow untouched).
`preferred_supplier_id` in `new_part`/`new_model` stamps the product's preferred
supplier (attribution only — never a payable; reuse doesn't overwrite) — this was
already in the function. Opening **qty 0** allowed (registers the catalog row, no
stock/line/movement; negative still rejected). is_owner() guard + price>cost kept.
`test-custom-product.mjs` (no-debt, qty 0, attribution, engine, reconciliation) +
extended `test-catalog-lock.mjs` (direct INSERT still fails; supplier-less create
via the RPC works); `test-supplier-payables` stays green — no phantom debt) ·
`0060` business rename **Jerry's Marine → Gerwin Trading** (`settings.business_name`
+ the notification-text functions rewritten, same pattern as 0036; historical
data/labels untouched) · `0061` sale payment method (`sales.payment_method`
`cash`|`gcash`|`bank`|`other`, default `cash` backfills every existing sale;
`fn_record_sale` gains `p_payment_method`, validated + stored — this is HOW the
money was tendered, orthogonal to `payment_type` which is HOW MUCH. For a partial
sale it describes the downpayment. Same value set as a shop expense's method, so
the vocabulary is one set app-wide. Prints on the receipt (`Paid via …` /
`Downpayment via …`) and shows on the Approval Queue + reviewed detail;
`test-pricing` extended) · `0062` internal barcode prefix **JM → GT** (Gerwin
Trading): `fn_generate_internal_barcode` + `fn_receive_stock` re-emit
`GT########`. NO backfill — already-printed `JM…` labels stay valid, and GT/JM
share `internal_barcode_seq` so a new GT code can never collide with an old JM
one. UI labels + `test-receiving`/`-inline`/`-custom-product` updated) · `0063`
payment method + reference on the AT-RECEIVING payment (`receivings.payment_method`
`cash`|`bank`|`gcash`|`check`|`other` + `reference_no`, both nullable; same enum as
`supplier_payments.method`. `fn_receive_stock` gains `p_payment_method`/
`p_reference_no`, stored only when money actually moved (v_paid > 0) — the
supplier-less "Add product" path and unpaid-on-credit leave them null.
DESCRIPTIVE ONLY: the balance stays `total − amount_paid − Σ(supplier_payments)`,
untouched; no backfill. Form shows the two fields only for Paid/Partial; the
receiving detail dialog prints `Paid via <method> · <ref>`. `test-receiving`
extended) · `0064` delivery-note prices (adds `cost_centavos` + `price_centavos`
to the `shop_incoming_delivery_lines` safe view so the SHOP's delivery note can
print per-line cost + selling + totals, matching the owner's. Read LIVE from
master — no capture at delivery. A deliberate WIDENING of the 0053 cost
narrowing: the shop already saw its own on-hand cost via `shop_stock`/
`shop_engines`; now it also sees the cost of stock being delivered to it, at the
owner's request. Owner's note reads `parts`/`engines` directly. `test-rls`
doesn't guard this view, so unaffected) · `0065` shop-initiated returns with
admin approval (returns become a REQUEST → APPROVE flow, mirroring transfers
0054 — the SHOP initiates a return of its own stock under **/shop/transfers →
"Return to Admin"** (status `requested`, NO stock moves), the OWNER approves or
rejects in **Deliveries & Returns → "Transfers & Returns"** (the New Return tab
is RETIRED; `fn_return_stock` kept for back-compat/tests but no longer called
from a screen). `returns` gains `status`/`requested_by`/`approved_by`/
`approved_at`/`review_note` (existing rows backfilled `approved`). RPCs:
`fn_request_return` (shop, own shop, validates on-hand), `fn_approve_return`
(owner — good → master, damaged → approved loss @cost, re-checks the shop still
holds each line; NO transit step, owner is the receiver), `fn_reject_return`
(note required), `fn_cancel_return` (shop, while requested). Shop-safe views
`shop_returns`/`shop_return_lines`. The owner Deliveries sidebar badge now also
counts `returns.status='requested'`. Reason + damaged chosen by the shop at
request time) · `0066` printable **Return Slip** (the document a shop→master
return travels with, mirroring the Stock Transfer Slip 0054). Party-scoped views
`return_slip`/`return_slip_lines` (readable by owner + the returning shop only —
a return has one non-owner party, no destination shop) back `/return/[id]/slip`
(outside every role group, like `/receipt` + the transfer slip — the view is the
gate, a non-party/anon reads no row → `notFound()`). Shows Returned by →
Admin/Master, lines split Good/Damaged (+ serials), reason, status, Admin note
when rejected; signature lines. No cost columns. "Print slip" on every shop
return card (`requested` onward) + each pending owner request) · `0067` shop
transfer destinations (BUGFIX: the shop "Send stock" picker read `shops`
directly, but `shops_select` (0002) scopes an employee to its OWN shop row, so
the destination list was always empty — "no other shops to transfer to", broken
since 0054. The transfer RPC always worked (SECURITY DEFINER, takes a shop id);
only the picker was starved. Fix = safe view `shop_transfer_destinations`
(security_barrier, identity-only: id/name/color_key of active live shops,
granted to authenticated) — nothing more than the transfer slip already shows a
party. `/shop/transfers` reads it instead of `shops`) · `0068` payer details on
an utang payment (`utang_payments` gains `method` `cash`|`gcash`|`bank`|`other`
(default `cash` backfills existing rows), `payer_name`, `payer_contact`.
`fn_record_utang_payment` gains `p_method`/`p_payer_name`/`p_payer_contact` —
**payer_name is REQUIRED** (raises otherwise), method validated against the same
four-value set as sales/expenses. DESCRIPTIVE ONLY: balance math unchanged
(`total − amount_paid − Σ approved payments`), no view changes — the shop +
owner Receivables read the columns straight off `utang_payments` for the payment
history. The shop Record-payment dialog gains a method picker + Paid-by name
(required, prefilled from the debtor) + contact; both histories print
"Paid by <name> · <contact> · via <method>". `test-receivables` extended;
all utang callers (`test-e2e`/`-pnl`/`-reviewed-history`) pass `p_payer_name`) ·
`0069` enum values for warranty claims (`engine_status += 'defective'`,
`loss_reason += 'warranty'`; standalone because an enum value can't be added and
used in one txn — see 0027) · `0070` shop-initiated **warranty-claim
resolution** with admin approval (mirrors returns 0065 — the SHOP that sold the
engine files a claim + proposed resolution, the OWNER approves/rejects, effects
run on approval). `warranty_claims` gains `status`/`resolution`
(`repair`|`replace`|`refund`)/`shop_id`/`requested_by`/`approved_by`/
`approved_at`/`review_note`/`replacement_engine_id`/`refund_centavos` (legacy
owner-logged rows backfilled `approved`). Safe view `shop_warranty_claims`
(scoped via warranty→sale→shop, like `shop_warranties`). RPCs
`fn_request_warranty_claim` (shop; validates the warranty is its own + the
replacement is on-hand), `fn_approve_warranty_claim` (owner), `fn_reject…`
(note), `fn_cancel…` (shop, while requested). **On approval**: *replace* books
the shop's on-hand replacement OUT as an approved **loss @cost** (reason
`warranty`, shrinkage — a ₱0 replacement can't go through `fn_record_sale`),
marks it sold to the customer, **repoints the warranty** to the new serial
(`on conflict (engine_id)` upsert), and sends the defective unit to master as
`status='defective'` (not sellable — supplier RMA out of band); *refund* books
the amount as an approved **company expense** ("Warranty Refunds") + defective
→ master; *repair* logs only; *reject* notes + nothing moves. No new movement
type — reuses `loss`/`return`. New notification types
`warranty_claim`/`_approved`/`_rejected`. The shop `/shop/warranties` gains a
File-a-claim dialog + My-claims list; the owner `/warranties` gains a
Claims-awaiting-approval section) · `0071` payroll **vale / cash-advance**
deduction (a tracked ledger, separate from the gov contributions). `staff_
advances` (owner-only) records money a staffer borrowed; `payroll_entries` gains
`vale_centavos` (the amount deducted on that payslip, frozen); view
`staff_advance_balances` computes `balance = Σ advances − Σ vale` per staffer.
`fn_apply_entry_contributions` is rewritten (supersedes 0041) to subtract the
vale in **every** path — `net = gross − Σ ee − vale`, with vale **capped to
available net** (gross − ee) so the `net_pay >= 0` CHECK can never fire; the
remainder **carries** to the next period. RPCs `fn_record_staff_advance`,
`fn_void_staff_advance` (refuses once deducted against), `fn_save_payroll_vale`
(owner; caps to available net + outstanding balance, then re-invokes the net
writer). New **Payroll → Advances** tab (give a vale · outstanding balances ·
history + void); the pay-period detail gains a **Vale** column + per-staffer
deduct dialog; the payslip prints a "Less: cash advance (vale)" line so
gross − contributions − vale = net ties out. A vale is a repayment, not a
business cost — it does **not** touch the P&L) · `0072` **suki discount cards**
(loyalty discount at POS. `discount_cards` (owner-only RLS): one ACTIVE card
per customer (partial unique index), `card_no` minted `SC########` from its own
sequence — a prefix distinct from `GT` product barcodes so a card scanned into
the product field is unambiguous. Settings dials `suki_engine_discount_pct`
(10) / `suki_part_discount_pct` (5) — rates are DATA, owner-editable from
Settings → Alerts. `sales` gains `discount_card_id` + `card_discount_centavos`
(program reporting only — the discount LIVES IN THE LINE PRICES, so revenue/
COGS/P&L need no special case). RPCs: `fn_create_discount_card` /
`fn_set_discount_card_status` (owner; reissue = deactivate + new number),
`fn_lookup_discount_card` (shop-callable definer, the shop's ONLY window into
cards: active card → customer + the two live percentages, NO cost, no
browsing — the fn_shop_warranty_preview pattern). `fn_record_sale` gains
`p_discount_card_id`: the card's customer IS the sale customer; per line the
card price = `round(catalog × (1−pct/100))` **capped at cost+1** (the 0053
strict floor survives thin margins) and the client's price is **clamped to ≤
card price** — guaranteed minimum: the cashier may tawad LOWER, never charge a
suki more; at/below cost still raises. Owner **/suki-cards** page (Sales &
Service): issue (existing or inline-new customer), deactivate/reactivate,
reissue, per-card usage (uses + Σ card_discount); **/suki-cards/[id]/print** —
the physical card, CR80 85.6×54 mm via a ROUTE-SCOPED `@page` (same isolation
rule as the 58 mm receipt), Code128 of the card_no (JSBarcode — the shops'
existing scanners read it), customer name, live terms. Record Sale gains a
suki field (scan or type; the product scan input routes `SC…` codes too):
lookup → prices drop to the card price per line ("suki max" = the ceiling,
input flags above-max), customer auto-filled + locked, Clear reverts to
catalog. Receipt prints "Suki card discount −₱X"; Approval Queue + reviewed
detail show the card no + program discount. `test-discount-cards.mjs` — the
suite REFUSES to run (exit 2) until 0072 is applied).

### Cost visibility — narrowed, not opened (0053)
"Cost is owner-only" (the discipline behind 0038 and the safe views) was
NARROWED, not abandoned. A shop now reads `cost_centavos` for its OWN on-hand
stock via the two scoped `security_barrier` views (`shop_stock`, `shop_engines`)
— read-only, so the cashier knows the tawad floor. **Everything else about cost
is still owner-only**: suppliers, `supplier_quotes`, `supplier_price_comparison`,
`supplier_product_prices_history`, payables, `receiving_lines`,
`sale_line_costs` (frozen COGS), another shop's stock, and master cost. Cost is
exposed ONLY by the column on those two views — never by a base-table grant (the
"column grants can't fix it" boundary still holds). `test-rls` asserts each
still-hidden surface explicitly.

### Two ways a part loses its own identity — don't confuse them
**Soft-delete** (`deleted_at` set, `merged_into` null) retires a discontinued
part; it vanishes from pickers, its history stays. **Merge** (0052:
`merged_into` set → `deleted_at` also set) additionally *redirects* the part to
a survivor so pricing/comparison roll up. Resolution is always
`coalesce(merged_into, id)`; a merge target must itself be canonical
(`merged_into is null`), so at most one hop. A merge NEVER touches
`stock_movements` — see 0052 above.

### Key backend functions (RPC, `SECURITY DEFINER`)
`fn_receive_stock`, `fn_deliver_stock`, `fn_return_stock`, `fn_record_sale`,
`fn_record_loss`, `fn_submit_shop_batch`, `fn_approve_sale`, `fn_approve_loss`,
`fn_approve_batch`, `fn_review_submission` (`sale`|`loss`|`payment`|`expense`),
`fn_record_shop_expense`, `fn_approve_expense`, `fn_merge_parts`,
`fn_set_product_image`, `fn_can_edit_product_image`,
`fn_generate_internal_barcode`, `fn_compute_tier_price`
(+ `engines_sync_tier_prices` trigger), `fn_sale_balance`,
`fn_record_utang_payment`, `fn_void_utang_payment`, `fn_notify`,
`fn_check_stock_alerts` (+ `stock_movements_alert_hook` trigger),
`fn_create_delivery_request`, `fn_fulfill_delivery_request`,
`fn_dismiss_delivery_request`, `fn_mark_notification_read`,
`fn_mark_all_notifications_read`, `fn_confirm_delivery`,
`fn_resolve_delivery_discrepancy`, `fn_warranty_alert_days`,
`fn_check_warranty_expiry` (daily via **pg_cron** `warranty-expiry-daily`,
01:00 UTC = 09:00 PH), `fn_supplier_outstanding`, `fn_supplier_limit_check`,
`fn_receiving_balance`, `fn_record_supplier_payment`,
`fn_check_supplier_limit_alerts`, `fn_check_supplier_overdue` (daily via
pg_cron `supplier-overdue-daily`, 01:15 UTC), `fn_contribution_basis`,
`fn_resolve_contribution`, `fn_apply_entry_contributions`, `fn_remittance_totals`,
`fn_cron_job_health`, `fn_stock_card`, `fn_shop_warranty_preview`,
plus count + payroll functions.

**Read-only by contract:** `fn_cron_job_health`, `fn_stock_card` and
`fn_shop_warranty_preview` write nothing — they are `SECURITY DEFINER` only
because pg_cron, window functions, and owner-only source tables (`engines` +
the `default_warranty_months` dial) are unreachable through a shop's PostgREST
session. Each re-checks its caller (`is_owner()`, plus `auth_shop_id()` for the
warranty preview's own-shop scope) for the reason 0042 exists: a definer
function without a role check is the hole RLS exists to close.

**Enforced now, not by memory (`test-definer-guards.mjs`).** Every definer
function granted to `authenticated` must guard its caller in-body. This is a
STATIC test over the migration SQL — it fails the build the moment a new
function is authenticated-callable without a guard. 0042 fixed two such holes;
the audit found three more that shipped *after* 0042 (`fn_supplier_outstanding`,
`fn_receiving_balance`, `fn_sale_balance` — fixed in **0047**). Two functions are
documented exceptions in that test: `fn_warranty_alert_days` (returns only a
non-sensitive settings int) and `fn_apply_entry_contributions` (transitively
guarded via `fn_contribution_basis`). The guard for the cron-called balance
functions is `is_owner() OR auth.uid() IS NULL` — **not** a plain `is_owner()`,
because the daily pg_cron sweeps run with no JWT (is_owner() false there), so an
owner-only guard would silently kill overdue/limit alerts. See 0047's header.

---

## Project Layout

```
app/
  (auth)/login/            Sign in (+ Forgot password? dialog)
  auth/                    callback (route handler) · reset — OUTSIDE every
                           route group: recovery must work when you can't sign in
  (owner)/                 Owner-only route group (layout gates role)
    dashboard/ reports/ settings/
    master-inventory/      + labels/ (view+edit only; bulk-add/ = stub, receiving
                           moved to /suppliers?tab=receiving via next.config 307)
    suppliers/             4 tabs: directory · receiving · payables · comparison
    suppliers/payables/    What we owe suppliers (owner-only)
    deliveries/            + [id]/note (print); tabs: delivery · return ·
                           transit-panel · transfers-panel
    stock-alerts/          + purchase-list (print) · request/[id]/receipt (print,
                           ingoing) · requests-panel (+ request-actions, moved
                           from deliveries)
    counts/                + [id]/ [id]/sheet (print)
    movements/             the ledger as a book; tabs: journal · ledger (stock
                           card) · engines (chain of custody)
                           + stock-card/print (print)
    approvals/
    warranties/            + [id]/certificate (print)
    shops/                 + [id]/stock/ reports/
    payroll/               + [id]/ staff/ positions/ reports/ payslip/[entryId] (print)
    expenses/              + categories/ reports/
  (shop)/shop/             Employee route group
    record-sale/ record-loss/ submissions/
lib/
  supabase/                client · server · proxy (middleware) · admin (service role)
  auth.ts format.ts ph-date.ts product-image.ts db-types.ts utils.ts
  pnl.ts                   THE profit math — imported by /reports?tab=pnl AND
                           /shops/reports so the two can never disagree
  business-identity.ts     getBusinessIdentity(supabase) — the letterhead for
                           all six documents, read from `public_settings`
components/
  shell/                   app-shell (sidebar/nav), approvals-badge, nav-badges
                           (live sidebar counts: Deliveries · Stock Alerts ·
                           Receivables · Warranties), print-button, section-tabs
  ui/                      shadcn/ui primitives
  data-table/ image-upload-field · product-image · receipt-image · location-picker · date-picker · view-toggle · confirm-dialog
supabase/migrations/       0001–0072 (schema, RLS, functions, features)
scripts/                   test-*.mjs verification scripts (one per deliverable)
```

### Sidebar count badges (owner nav)
The Approval Queue's live count is generalized in `components/shell/nav-badges.tsx`
to five more owner pages — each shows a "needs your attention" number, hidden at
0. What each counts (deliberate, not obvious):
- **Deliveries & Returns** — transit discrepancies + shop-to-shop transfers
  awaiting approval (`deliveries.status in ('requested','discrepancy')` catches
  transfer requests + every discrepancy; plain in-transit waits on the shop, so
  it's excluded). Shop stock-requests moved to Stock Alerts.
- **Stock Alerts** — every low-stock item (master + all shops:
  `master_low_stock` + `shop_low_stock`) PLUS open shop stock-requests
  (`delivery_requests` status `open`).
- **Suppliers** — OVERDUE supplier debt (`receiving_balances` where `overdue`),
  the same red rows the Payables tab flags. Overdue is a DATE-based state (no
  table event fires when a due date passes at midnight), so this leans on the
  focus/visibility refresh + the daily `fn_check_supplier_overdue` cron (which
  raises a notification → realtime bump). The count is ALSO surfaced on the
  Payables sub-tab itself (`supplier-tabs.tsx`, red destructive badge) since
  that's where the Pay action lives. Overdue-only, not every open payable — a
  badge that lit up for any credit purchase would be permanent noise.
- **Receivables** — sales with a live balance (`receivables.balance_centavos > 0`).
- **Warranties & Serials** — shop-filed **warranty claims awaiting approval**
  (`warranty_claims.status='requested'`, 0070) — the one thing the owner acts on
  here; clears as each is approved/rejected. NOT the serial registry or pending
  engine sales (those live on the Approval Queue).

Each keeps fresh via a realtime subscription on its feeder tables (sales,
deliveries, delivery_requests, utang_payments, notifications are in the
`supabase_realtime` publication) PLUS a reload on tab focus — the safety net for
counts derived from tables NOT in the publication (stock levels feed Stock
Alerts). All are owner-only; a shop session never renders them.

### Per-page code pattern
Each route is a server component `page.tsx` (data fetch + metadata) that renders
a client `*-view.tsx` / `*-form.tsx` component; mutations go through server
actions in a colocated `actions.ts` that call the RPC functions above.

### Verification
**`npm test`** runs every suite and prints one table (~1,100 assertions, ~4 min).
Add `--with-http` to include `test-reports` and `test-settings-documents`, which
need `npm run dev`. `--only=<substr>` runs a subset. Suites run **sequentially** —
several assert on global counts, so parallel runs make them flap.

`TEST_BASE_URL` defaults to `http://localhost:3000`, and **that default is wrong
more often than it's right**: `next dev` silently moves to 3001/3002 when 3000 is
taken, and another project's dev server on 3000 answers happily with 45
failures that all look like broken code. `test-settings-documents` fingerprints
the sign-in page and refuses a stranger; point it at the real port:
`TEST_BASE_URL=http://localhost:3001 npm test -- --with-http`.

**Next 16 serves a server-component `redirect()` to a plain GET as a 200 with
a `<meta id="__next-page-redirect" http-equiv="refresh">` tag — NOT a 3xx.**
An HTTP test asserting status 307 on a redirect stub fails against a stub that
works perfectly in every browser; assert the *target URL* by either mechanism
(see test-ia-redirects.mjs).

**Never pipe a suite through `head`.** `head` closes the pipe, node dies on
EPIPE *before cleanup runs*, and fixtures + a rewritten live settings row are
left behind. Redirect to a file and tail it instead.

### The harness (`scripts/_harness.mjs`) — read this before writing a test
Every suite **provisions its own throwaway shop + employee** via the service role
and hard-cleans afterwards. Two reasons, both learned the hard way:
1. The seeded shop logins (`branch1@jerrysmarine.test`, …) were replaced with
   real ones when the app went live — **14 of 15 legacy scripts were dead at
   sign-in**, silently, for weeks.
2. Those scripts hardcoded the seed shop UUIDs, which are now the **real**
   Branch 1 / Branch 2 — so they wrote test stock into live shops.

API: `owner` · `admin` · `anonClient()` · `RUN` · `P()` · `check()` ·
`section()` · `summary()` · `provisionShop()` · `seedPart/EngineModel/Supplier/
Customer/ExpenseCategory()` · `trackEngine/Shop/Customer/Receipt()` ·
`receive()` · `deliverAndConfirm()` · `cleanup()`.

Rules that keep this safe on a live database:
- **Never** hardcode a shop UUID or sign in as a real shop login.
- Cleanup is `await cleanup()` — one call, at the end. Don't hand-roll deletes.
- Scope every filter to the run (`` .like("note", `%${RUN}%`) ``), never a bare
  prefix — a prefix delete is one statement matching *every* run's rows, so one
  FK-blocked straggler poisons them all (and concurrent runs delete each other's
  fixtures).
- Delete `stock_movements` by **both** shop_id AND part/engine id: the
  master-side row has `shop_id IS NULL`, so a shop-only delete strands it and
  every later delete fails on the FK.
- `fn_record_sale` creates customers **inline**, so there's no id to track —
  cleanup sweeps them by `%RUN%` name.

`scripts/sweep-test-fixtures.mjs` removes `ZZ-TEST` orphans left by a crashed
run (dry run by default; `--yes` to delete). Don't run it while suites are
running. It skips soft-deleted rows — the pre-2026-07-10 scripts retired their
fixtures with `deleted_at`, and some are FK-pinned by real ledger rows.

### Suites
`test-harness` (proves the harness itself cleans up) · **`test-e2e`** (one
continuous admin→shop→admin story: supplier debt → receive → deliver → confirm
→ discrepancy → sell → submit → approve → warranty → COGS → utang → void →
settle → low stock → request → pay supplier → profit reconciles) · `test-rls`
(the security backbone) · plus one per feature: receiving, receiving-inline
(0048 single-entry: inline creation, atomicity, picked due date, limit
override, RLS), catalog-lock (0049: direct catalog INSERT fails even for the
owner; receiving still creates; UPDATE untouched; 0059: supplier-less create via
the RPC works), custom-product (0059: supplier-less Add product/engine — no debt,
opening qty 0, > cost, attribution sets preferred supplier, reconciliation),
categories (0059-era: owner create/rename/retire, exact-dup refused, employee
blocked by RLS, retire keeps the product's link), deliveries,
delivery-confirm, receipt-damage (0058: delivery confirm records good/damaged/
missing + photo prefix guard + reason-tagged resolve; return inspection good→
master / damaged→approved loss @cost; reconciliation after every step),
transfers (0054: request→approve→confirm→resolve, authority,
reconciliation invariant, engine serial-integrity, view RLS + slip scoping),
returns (0065/0066: shop request→approve/reject/cancel, good→master + damaged→
approved loss @cost, damaged engine→soft-delete+loss, approve re-checks the shelf,
reconciliation, shop_returns RLS + return_slip party-scoping),
convert-request (pure classifier: available/partial-capped/no-stock for parts +
engines, serials never reused), counts, shop-recording, approvals, batch-submission,
warranties, shop-warranties, warranty-preview (0055: point-of-sale cert before
approval, engine→model→settings term fallback, own-shop guard, voids with the
sale; 0056/0057: branch location + logo path thread onto the cert),
warranty-claims (0069/0070: shop files repair/replace/refund → owner approve/
reject/cancel; replace books replacement-out loss @cost + warranty repoint +
defective→master, refund→company expense, authority + third-shop RLS),
receivables,
discount-cards (0072: suki cards — owner-only issuing + one-active-per-customer,
SC prefix, shop lookup returns customer+rates only, card price server-derived
with cost+1 cap, client price clamped to the card price, inactive card dead,
card-less sale unchanged; refuses to run until 0072 is applied),
pricing (0053: unified single price,
sale floor = cost strictly-greater for parts + engines, cost visible read-only
to the shop, no tiers remain), stock-alerts,
shop-colors (0050: CHECK, live-unique, release-on-close, RLS),
shop-expenses (0051: RPC forces own-shop, only-approval-counts, category
propose/remap, receipts path isolation, reviewed history),
part-merge (0052: owner-only, refuses stock/transit/open-lines, audit, no
ledger write, invariant intact, one-hop, comparison rollup),
reviewed-history, supplier-payables, shop-profitability, expenses, payroll,
payroll-contributions, payroll-vale (0071: record advance→balance, deduct
installment, cap to balance, cap to net + carry, void + refusal, no-advance,
paid-immutable, authority), images, shop-images, admin, close-shop, reports,
settings, settings-documents (HTTP), pnl, movements, supplier-comparison,
ia-redirects (HTTP).

**`test-pnl` imports `lib/pnl.ts` directly** rather than scraping the rendered
page or re-deriving the arithmetic — a test that reimplements the math proves
nothing about the code the pages run. That is also why `lib/pnl.ts` has no
`server-only`: it holds no secret and takes the caller's client, so RLS is the
real guard (and `computePnl` re-checks `is_owner()` itself — run on a shop's
session every query SUCCEEDS and just returns less, yielding a confident
net income made entirely of revenue).

Suites that edit the live `settings` row (`test-settings`,
`test-settings-documents`, `test-payroll-contributions`) capture it and restore
in a **try/finally** — `process.on("exit")` cannot await, so an async restore
never lands. They also refuse to start if they find `ZZ-TEST` already in the
row: capturing polluted data as the "original" restores the pollution and
reports success, making it permanent and self-certifying.
