@AGENTS.md

# Jerry's Marine — Inventory & Sales-Approval System

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
3. Shop **records** sales and losses — these save as status `recorded` and are **invisible to the owner**.
4. Shop **submits a batch** ("Submit to Admin") — all recorded sales and losses flip to `pending` under one `submission_batch`. (Utang payments are **not** part of this — see 7.)
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

**45 distinct routes** (+4 redirect stubs). `[id]`/`[entryId]`/`[saleId]` are dynamic detail routes. "Print" pages are standalone print-optimized documents.

**The sidebar reads like the business works** (IA reorg, 2026-07): OVERVIEW →
INVENTORY in stock-flow order (Suppliers → Master Inventory → Deliveries →
Stock Alerts → Monthly Count → Movements) → SALES & SERVICE → ADMINISTRATION.
Three routes moved and left stubs (same pattern as `/delivery-requests`):
`/master-inventory/suppliers` → `/suppliers?tab=directory` ·
`/suppliers/payables` → `/suppliers?tab=payables` ·
`/shops/reports` → `/reports?tab=shops` (forwards its query string).

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
| `/suppliers` | Suppliers | Three tabs (`?tab=`): **Directory** (supplier records, credit limits, terms, outstanding inline — moved unchanged from Master Inventory) · **Payables** (what Admin owes: aging buckets, per-receiving balances, Record Payment targeted/FIFO, private receipts — moved unchanged from /suppliers/payables) · **Price Comparison** (per product × supplier: last-PAID from receivings with zero data entry + owner-entered quotes; every price carries source + date — never a bare number; stale quotes flagged, effective price falls back to last-paid; "Preferred is ₱X more" badge; Make-preferred + Record-quote inline) |

### Owner — Master Inventory (4)
| Route | Page | Purpose |
|-------|------|---------|
| `/master-inventory` | Products | Central catalog of parts & engines (cards/table, photos, margins) |
| `/master-inventory/receiving` | Receiving | Log incoming stock from suppliers into master inventory |
| `/master-inventory/bulk-add` | Bulk Add | Add many products at once |
| `/master-inventory/labels` | Print Labels | Generate/print Code128 barcode labels |

### Owner — Deliveries (2)
| Route | Page | Purpose |
|-------|------|---------|
| `/deliveries` | Deliveries & Returns | One page, four tabs: **New Delivery** (into transit) · **New Return** · **In transit** (+ the **discrepancy queue** → return to master or transit write-off) · **Requests** (shops' stock requests, badge = open count; Convert pre-fills the New Delivery tab and links the request on save; Dismiss with a reason). `?tab=` deep-links a tab; `?request=<id>` pre-fills the delivery form |
| `/deliveries/[id]/note` | Delivery Note | Printable delivery note document |

### Owner — Stock Alerts (2)
| Route | Page | Purpose |
|-------|------|---------|
| `/stock-alerts` | Stock Alerts | Master low stock (→ buy from supplier) · all shops' low stock (→ deliver) · reorder levels + per-shop overrides |
| `/stock-alerts/purchase-list` | Purchase List | Printable supplier order sheet, grouped by supplier, with suggested order qty |

`/delivery-requests` is now a **redirect** to `/deliveries?tab=requests` (kept so
old bookmarks don't 404) — delivery requests live as a tab on Deliveries, since
converting one only ever pre-filled that page's form.


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

### Owner — Sales & Service (4)
| Route | Page | Purpose |
|-------|------|---------|
| `/approvals` | Approval Queue | **(a)** Pending: review shop submission batches (sales + losses), one-click Approve-all + per-item actions, live updates. **(b)** Reviewed History: every decided sale/loss/utang payment, filterable (shop · type · status · date · search) with server-side pagination; click a row for a deep-linked slide-over detail (`?item=<type>:<id>`) |
| `/receivables` | Receivables | All unpaid balances across shops — totals per shop/customer, filters, CSV export, per-sale payment history (incl. voided) |
| `/warranties` | Warranties & Serials | Engine serial registry + warranty tracking across all shops; shop filter + selling-shop column; claims |
| `/warranties/[id]/certificate` | Warranty Certificate | Printable warranty certificate |

### Owner — Shops & Employees (2)
| Route | Page | Purpose |
|-------|------|---------|
| `/shops` | Shops & Employees | Purely operational since the IA reorg: manage shops (map pins, credentials, close-shop), 2-col cards. Per-branch profitability lives at `/reports?tab=shops` |
| `/shops/[id]/stock` | Shop Stock | View a single shop's on-hand stock |

### Owner — Payroll (6)
| Route | Page | Purpose |
|-------|------|---------|
| `/payroll` | Run Payroll | Payroll dashboard / run a pay period |
| `/payroll/[id]` | Pay Period | Detail of one pay period and its entries |
| `/payroll/staff` | Staff | Manage staff records (people, not app logins) |
| `/payroll/positions` | Positions | Job positions / rates |
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

### Shop / Employee (9)
| Route | Page | Purpose |
|-------|------|---------|
| `/shop` | My Shop Stock | Shop's on-hand stock + today's sales KPIs; edit own product photos |
| `/shop/warranties` | Warranties | **Read-only** — warranties for engines THIS shop sold; serial lookup (scan-friendly), status + near-expiry highlighting. No edit/void/extend/claim |
| `/shop/warranties/[id]/certificate` | Warranty Certificate | Same document as the owner's, reprintable; ownership re-checked server-side |
| `/shop/deliveries` | Incoming Deliveries | Count + confirm what actually arrived (no reject/return — a shortfall goes to Admin); history |
| `/shop/low-stock` | Low Stock | This shop's items at/below their effective threshold → Request delivery from Admin; own request history |
| `/shop/record-sale` | Record Sale | Scan/browse cart, cash/change helper; engine tier pricing (floor/mid/asking) with negotiated agreed price + hard floor, partial payment (customer required); saves as `recorded` |
| `/shop/record-loss` | Record Loss | Reason-tagged write-off request; saves as `recorded` |
| `/shop/receivables` | Receivables (Utang) | This shop's outstanding balances + Record Payment (posts immediately) + payment history with void |
| `/shop/submissions` | Submissions | Current report (unsent) → Submit batch to Admin; Submitted / Reviewed tabs |

### Shared document (1)
| Route | Page | Purpose |
|-------|------|---------|
| `/receipt/[saleId]` | Receipt | Printable sale receipt (buyer's copy + owner's digital copy), rendered from the recorded sale — same numbers by construction. RLS-scoped to owner + selling shop. |

**Feature summary for billing:** ~15 functional modules — Auth (+ password
recovery), Dashboard, Reports (+ consolidated P&L / Net Income), Master
Inventory (+Receiving/Bulk/Labels/Suppliers), Deliveries & Returns, Monthly
Count, Movements (journal · stock card · engine chain of custody), Approval
Queue, Warranties, Shops & Employees, Payroll, Expenses, Receivables/Utang,
Stock Alerts (+ Delivery Requests, a tab on Deliveries), Suppliers (directory ·
payables · price comparison with provenance-labelled quotes),
Settings (6 sections incl. credential change + system health), and the 6-page
Shop app. Plus 7 printable documents (delivery note, count sheet, warranty
certificate, payslip, sale receipt, supplier purchase list, stock card) and
cross-cutting systems (image pipeline, maps, barcodes, realtime approvals,
engine 3-tier negotiable pricing with server-enforced hard floor + partial
payment, a receivables/payments ledger with void + audit trail, supplier debt
with credit limits + audited overrides, and channel-agnostic in-app
notifications).

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

Reconciliation invariant (asserted in `test-delivery-confirm.mjs` after every
step): `sum(stock_levels.qty) + sum(stock_in_transit.qty) = total owned`. Only
a transit write-off may reduce total owned. `stock_in_transit` is a **view**
over `delivery_lines.qty_outstanding` (generated column), so the bucket can
never drift from the line it came from. Reports keep **transit write-offs**
(`movement_type='transit_writeoff'`) separate from **shop losses** (`losses`
table) and **returns** (`return`) — three different things.

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
`product_categories`, `engine_models`, `parts`, `part_fitments`, `customers`,
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

**Expenses:** `expense_categories`, `expenses` (scoped since 0013: `scope`
`shop`|`company` + `shop_id`, paired by the `expense_scope_shop` CHECK —
shop-scoped needs a shop, company-wide must not have one).

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
all), cost columns removed, `security_barrier`. `public_settings` is the odd one
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

### Migrations (`supabase/migrations/`, 0001–0046)
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
as "Admin" (business name stays "Jerry's Marine" in `settings.business_name`;
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
both views `is_owner()`-guarded).

### Key backend functions (RPC, `SECURITY DEFINER`)
`fn_receive_stock`, `fn_deliver_stock`, `fn_return_stock`, `fn_record_sale`,
`fn_record_loss`, `fn_submit_shop_batch`, `fn_approve_sale`, `fn_approve_loss`,
`fn_approve_batch`, `fn_review_submission` (`sale`|`loss`|`payment`),
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
`fn_cron_job_health`, `fn_stock_card`,
plus count + payroll functions.

**Read-only by contract:** `fn_cron_job_health` and `fn_stock_card` write
nothing — they are `SECURITY DEFINER` only because pg_cron and window functions
are unreachable through PostgREST. Both re-check `is_owner()` for the reason
0042 exists: a definer function without a role check is the hole RLS exists to
close.

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
    master-inventory/      + receiving/ bulk-add/ labels/ suppliers/
    suppliers/payables/    What we owe suppliers (owner-only)
    deliveries/            + [id]/note (print); tabs: delivery · return ·
                           transit-panel · requests-panel (+ request-actions)
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
  shell/                   app-shell (sidebar/nav), approvals-badge, print-button, section-tabs
  ui/                      shadcn/ui primitives
  data-table/ image-upload-field · product-image · receipt-image · location-picker · date-picker · view-toggle · confirm-dialog
supabase/migrations/       0001–0046 (schema, RLS, functions, features)
scripts/                   test-*.mjs verification scripts (one per deliverable)
```

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
(the security backbone) · plus one per feature: receiving, deliveries,
delivery-confirm, counts, shop-recording, approvals, batch-submission,
warranties, shop-warranties, receivables, engine-pricing, stock-alerts,
reviewed-history, supplier-payables, shop-profitability, expenses, payroll,
payroll-contributions, images, shop-images, admin, close-shop, reports,
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
