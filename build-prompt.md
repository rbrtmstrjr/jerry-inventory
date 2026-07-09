# BUILD PROMPT: Marine Store Multi-Shop Inventory & Approval System (All-Web) — "Jerry's Marine"

## Goal
Build a centralized, web-based inventory and sales-approval system for a Philippine marine store (outboard boat engines + parts + fisherman goods) that supplies 3–5 branch shops. The OWNER (Jerry) holds all inventory centrally, delivers stock to shops, and approves every shop's sales and losses before stock deducts. EMPLOYEES at each shop can only see their own shop's delivered stock and record sales/losses for the owner to approve — never the master inventory, costs, or other shops. One web app, role-based, backed by one central database.

## The Business Model (this drives everything)
Stock is owner-controlled and moves ONLY on these events:
- **Delivery** (Jerry → shop, auto-lands in shop stock)
- **Return** (shop → Jerry, back into master stock)
- **Approved sale** (employee records → Jerry approves → shop stock −, counts as revenue)
- **Approved loss/adjustment** (employee records damaged/missing/expired with a reason → Jerry approves → shop stock −, counts as a write-off)

Employees RECORD; they never MOVE stock. Sales and losses are submitted together in the shop's daily batch, each line tagged by type, so Jerry can question anything before approving. Monthly, shops physically recount; any shortage is entered as reason-coded losses that flow through the same approval queue. There is NO separate reconciliation subsystem — the audit reuses the loss/approval flow, plus a printable count sheet.

## Tech Stack (use exactly this)
- **Framework:** Next.js (App Router) + React + TypeScript
- **Database + Auth + Realtime:** Supabase (Postgres). Supabase Auth for owner/employee roles; **Row-Level Security is the access enforcer**; Supabase Realtime for the near-live approval queue.
- **Styling:** Tailwind CSS (v4) + **shadcn/ui**
- **Data tables:** TanStack Table (inventory, sales, approval queue, reports)
- **Charts:** Recharts (via shadcn charts)
- **Forms:** react-hook-form + zod
- **Barcodes:** scanning via keyboard-wedge USB scanners (single focused input, capture value + Enter — no SDK); label generation via **JsBarcode (Code128)**; optional camera scanning (zxing/html5-qrcode) for tablet/phone fallback
- **PDFs:** delivery notes, sales invoices, warranty certificates, month-end count sheets (server-side render or react-pdf)
- **Deploy:** Vercel
- **Data freshness:** near-live for visibility (Realtime pushes new submissions to Jerry); stock only changes on Jerry's approval

## Design System (centralized, rebrandable — shadcn)
- ALL tokens (colors, radius, spacing, typography, shadows) in ONE file (`app/theme.css` or `styles/theme.css`), shadcn conventions (`--background`, `--foreground`, `--card`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`, `--chart-1..5`), light + dark sets.
- **No hardcoded colors in components — treat inline hex as a bug.** Rebranding = editing this one file.
- Placeholder palette: clean marine/nautical (deep-sea blue primary, warm neutral surfaces, clear accent), professional and legible. Leave a clearly-commented brand block at the top for the client's final colors.
- One spacing scale, one radius, one elevation system, a clear type scale — all tokenized.

## Access & Roles (HARD REQUIREMENT — enforced by RLS, not just UI)
- **Owner (Jerry):** full access — master inventory, costs, suppliers, all shops, deliveries, approvals, reports.
- **Employee:** scoped to exactly ONE `shop_id`. Can SELECT/INSERT only their own shop's stock and their own recorded sales/losses. **Cannot** read: master inventory, cost/margin fields, other shops, or any owner-only figures.
- Enforce with **Supabase RLS policies** keyed on the authenticated user's `shop_id` and role. Employees read a shop-scoped view that EXCLUDES cost columns (they see selling price only). Sensitive data must be physically unreachable, not hidden client-side.
- Every stock/sale/loss/delivery/return row carries `shop_id` (and master rows are owner-scoped).

## Environment & Constraints
- Web app opened in a browser on a desktop/laptop per shop (shops are adding WiFi). Owner opens from any device.
- **Money stored as integer centavos** (₱12.50 → 1250). Never floats.
- Every table: UUID `id`, `shop_id` where applicable, `created_at`, `updated_at`, soft-delete, and status fields where noted.
- Start FRESH — no migration from the old system. Jerry enters master stock manually; provide a **bulk-add screen** so initial catalog entry isn't one-at-a-time.
- Filipino/English mixed labels welcome (nasira, nawala, delivery, etc.).

## Data Model & Modules

### 1. Shops & Employees
Shops (name, location, active). Employees (name, login, role, assigned `shop_id`). Owner can create shops and assign employees.

### 2. Product Catalog (owner-managed)
Two product natures under one catalog:
- **Engines — SERIALIZED:** each physical unit is its own row (serial_number unique, brand, model, HP, stroke type, condition, cost, price, warranty term, status: in_master | delivered | sold | returned). Never quantity-counted.
- **Parts & Fisherman Goods — QUANTITY:** name, category, sku/barcode (optional), unit, cost, price, reorder_level. Categories: Engine Parts, Oil & Lubricants, Fisherman Gear, Consumables — seed these.
- **Fitment/compatibility:** many-to-many part ↔ engine model ("this impeller fits Yamaha 40HP"). Time-saver at point of sale.
- Optional product image (helps employees identify parts).
- Engine model catalog (brand/model/HP/warranty term) as reusable reference data; seed common PH outboard brands.

### 3. Master Inventory & Receiving (owner only)
- Jerry's central stock — the top of the funnel, invisible to shops.
- **Suppliers** (name, contact) and a **Receiving/Purchase** flow: log incoming stock from suppliers into master (engines by serial, parts by qty), with cost. This is "raw incoming."
- **Barcode label generation:** for unbranded/repacked goods with no manufacturer barcode, auto-generate an internal **Code128** code and print labels (barcode + name + price). From then on it scans like any barcoded item.

### 4. Deliveries (Jerry → shop) & Returns (shop → Jerry)
- **Delivery:** Jerry moves items from master to a chosen shop; stock **auto-lands** in that shop (no employee confirmation needed — Jerry controls inventory). Generates a printable **delivery note PDF**. Serialized engines move by serial; parts by qty.
- **Return:** a shop can send stock back to Jerry's master (slow-movers, redistribution, damaged-for-return). Stock −shop / +master, logged with reason.
- Both are stock-movement events in the ledger, `shop_id`-stamped.

### 5. Shop View — Record Sales & Losses (employee)
- Employee sees ONLY their shop's on-hand stock (selling price, no cost).
- **Record a sale:** barcode-scan or search to add items (parts by qty; engine by scanning/entering serial), attach customer (optional for parts, required for engine warranty), compute total. **Does NOT deduct stock** — creates a PENDING sale line.
- **Record a loss/adjustment:** mark item(s) as nasira (damaged) | nawala (missing) | expired | sample/libre | correction, with quantity and note. Also PENDING, tagged with reason.
- Sales and losses accumulate into the shop's **daily submission batch** to Jerry. Each line tagged (sale vs. loss-reason).
- Employee dashboard: their shop's on-hand, today's recorded sales, pending submissions, low-stock flags.

### 6. Approval Queue (owner) — near-live
- Jerry sees incoming submissions **near-live via Supabase Realtime** (visibility without pressuring employees — no waiting on them).
- Queue grouped into **Sales** and **Losses/Adjustments** sections so he reviews like with like; each line shows shop, item, qty/serial, type/reason, employee, time.
- Jerry can **question** (flag/comment) a line before approving. On **approve**: stock deducts — sales as revenue, losses as reason-coded write-offs; approving an **engine sale** marks that serial `sold`, captures customer + sale date, and **auto-creates the warranty record** (sale date + term → expiry). Reject/return-for-clarification supported.
- Guard: block/flag approvals that would drive shop stock negative.

### 7. Warranty & Serial Tracking (engines)
- Per engine: serial → customer → sale date → warranty term → **expiry** → status (active/expired).
- **Serial lookup:** search any serial → who bought it, which shop, when, warranty status. Light warranty **claim log** (date, issue, action). Printable **warranty certificate PDF** on engine sale.

### 8. Stock Movements Ledger (audit trail)
Every event: received (master) | delivery | return | sale | loss(reason) | correction. Records item/serial, qty, `shop_id`, actor, timestamp, and (for sales/losses) the approval reference. This is the single source of truth for how any unit moved.

### 9. Barcode & Hardware Features (woven throughout)
- **Scan-to-sell:** USB keyboard-wedge scanner on the record-sale screen (focused input, Enter adds the item). Same pattern for scanning engine serials.
- **Label printing:** Code128 labels for internal/unbranded items (from master inventory).
- **Optional camera scan** fallback for tablets/phones.
- Global search resolves serials, part names/SKUs, and customers.

### 10. Reports & Dashboards (owner)
- Cross-shop and per-shop: **approved sales (revenue)** and **approved losses (shrinkage by reason)**, engines sold (with serials), production/stock levels, low-stock, pending-approval count.
- **Default daily, but filterable to ANY date range** (Jerry said not to limit to per-day).
- Charts: sales trend, sales by shop, losses by reason, top-selling parts, low-stock overview.
- Export CSV/PDF.

### 11. Monthly Audit / Physical Count
- **Printable count sheet** per shop listing each item with expected quantity (offer a blind-count option that hides expected until after entry — better practice).
- After counting, any shortage/damage found is entered as **reason-coded losses** that flow through the normal approval queue (no separate mechanism). Optional month-end **snapshot** so the count is against a frozen figure.
- Result: Jerry gets "expected vs. counted, per item, variances flagged," automating his old manual cross-check.

### 12. Settings
Business/receipt info, warranty defaults, shop & employee management, reorder thresholds, brand note pointing to `theme.css`. Owner-only.

## UI / UX Requirements
- **Two role-based layouts** from one codebase: Owner hub (master inventory, deliveries, approval queue with live badge, reports, shops) and Employee shop view (their stock, record sale, record loss, submissions).
- **Data grids:** TanStack Table — sort, filters, global search, sticky headers; low-stock and warranty-expiry highlighting; virtualization for large lists.
- **Forms:** react-hook-form + zod, inline validation, shadcn inputs/dialogs; scan-or-type for serials and barcodes.
- **Feedback states:** loading, empty ("no stock delivered yet"), and helpful errors on every screen. Owner approval queue shows a live pending count.
- **Money & numbers:** tabular ₱ figures, rendered from centavos at the edge; employees never see cost/margin.
- Fast keyboard flow for recording sales; big clear buttons; usable by non-technical staff.
- Dark + light mode, fully token-driven. Toasts (sonner) on record/approve/deliver.
- Accessibility: keyboard nav, visible focus, reduced-motion respect.

## Non-Functional
- All multi-write operations (approval → deduct, delivery, return, receiving) wrapped in DB transactions / Postgres functions so stock never partially updates.
- RLS policies tested: prove an employee cannot read master inventory, costs, or another shop.
- Idempotent seed (roles, one owner, sample shops, engine-model catalog, part categories).
- Robust error handling; near-live is best-effort — a Realtime hiccup must never lose a submitted sale (it's persisted, Realtime is only the notification).
- Optional: make the **record-sale screen a PWA** with light offline-queue so a brief WiFi drop doesn't block a sale (flushes when back). Nice-to-have, since shops are adding WiFi.

## Deliverables (build in this order — confirm each runs before moving on)
1. **Scaffold:** Next.js (App Router) + TS + Tailwind v4 + shadcn/ui + Supabase client + Vercel-ready. Centralized `theme.css` (marine placeholder + brand block). Auth + role-based app shell (owner vs employee layouts). Verify it runs and deploys.
2. **Supabase schema + RLS:** shops, employees/roles, product catalog (serialized engines + quantity parts), master inventory, movements, sales, losses, deliveries, returns, warranties. Write and TEST all RLS policies + the cost-excluding employee view. This is the backbone — get it airtight.
3. **Master inventory + suppliers + receiving** (owner) + bulk-add + Code128 label generation.
4. **Deliveries (auto-land) + returns** + delivery-note PDF.
5. **Shop view:** employee stock (no cost) + record sale (barcode scan, serial capture) + record loss (reason-tagged) as pending daily submission.
6. **Approval queue** (Realtime, grouped sales/losses, question → approve → deduct) + warranty auto-create on engine-sale approval + negative-stock guard.
7. **Warranty & serial tracking** + serial lookup + claim log + warranty certificate PDF + fitment.
8. **Reports & dashboards** (owner + employee), any-date-range, charts, CSV/PDF export.
9. **Monthly count sheet** + snapshot + shortage-to-loss flow.
10. **Settings, dark mode, PWA hardening on record-sale, polish pass.**

Start with deliverable 1, and treat deliverable 2 (schema + RLS) as the critical backbone — if the access rules are airtight, everything else is styling on top. Confirm each runs before moving on. Ask before major architectural changes.