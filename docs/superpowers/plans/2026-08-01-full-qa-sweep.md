# Full QA Sweep — Gerwin Trading Inventory

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to work through this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exercise every interactive surface in the app — every dialog, form field, upload, empty state, validation refusal, role gate, and printable document — against realistic data, and fix what it uncovers before the production Supabase project is created.

**Approach:** This is a *manual* QA sweep driven by a written inventory of the real components (produced by reading every `.tsx` in `app/` and `components/`), not by memory of the feature list. Each task covers one area and is exercised in five passes: **happy path → validation → empty/error states → role gating → mobile**. A task is done when every checkbox is ticked or has a logged bug. Bugs are fixed as described in Task 0, not deferred to the end.

**Tech Stack:** Next.js 16 (App Router) · React 19 · Tailwind v4 + shadcn/ui (Radix) · Supabase (Postgres + Auth + Storage + Realtime) · TanStack Table · Recharts · Leaflet · JSBarcode

## Global Constraints

- **Environment: staging only.** `.env.local` must read `SUPABASE_ENV=staging`. Never point this sweep at production. The dev server runs at `http://localhost:3000` (`npm run dev`).
- **Data:** the staging database holds 2 years of seeded history (2024-07-31 → 2026-07-31), 10 branches, ~208k ledger rows, plus the in-flight QA states (pending batches, in-transit deliveries, discrepancies, transfer/return requests, 30 warranty claims, 60 stock requests, overdue payables).
- **Three logins, three browser profiles kept open side by side:**
  | Role | Credentials | Home |
  |---|---|---|
  | **GERRY** (owner) | `gerwintrading@test.com` / password in `.env.local` | `/dashboard` |
  | **ADMIN** (office) | the `role='admin'` account in Settings → Admins | `/dashboard` |
  | **SHOP** (employee) | `shop1@gerwin-test.ph` / `gerwin123` | `/shop` |
- **A refusal is a PASS.** Steps marked ❌ must fail. If a ❌ step succeeds, that is an S1 bug.
- **Money is centavos** — every peso figure must render with 2 decimals and thousands separators, right-aligned, tabular (no column jitter).
- **Never edit an applied migration.** Any schema fix found here becomes a new numbered file (`0113_…`), pushed to staging first (`docs/DEPLOYMENT.md`).
- **The six owner-only locks under test throughout:** cost/selling price edits (0100) · utang payment void (0101) · catalog retire/merge (0102) · shop credentials + close shop (0104) · expense void (0105) · the Gerry-only pages (Reports, Settings, Expenses→Reports).

---

### Task 0: Setup, bug protocol, and the role matrix

**Surface:** `.env.local`, `npm run dev`, `docs/superpowers/plans/2026-08-01-qa-bugs.md`

**Preconditions:** none — this task establishes them.

- [ ] **Step 1: Confirm the environment is staging**

```bash
grep SUPABASE_ENV .env.local     # must print SUPABASE_ENV=staging
npm run dev                       # note the port; Next moves to 3001 if 3000 is taken
```

Expected: `SUPABASE_ENV=staging`, server listening. If it says `production`, **stop** — this sweep must not run there.

- [ ] **Step 2: Create the bug log**

Create `docs/superpowers/plans/2026-08-01-qa-bugs.md` with this table and append a row per finding:

```markdown
| # | Severity | Area | Route / component | What happened | Expected | Status |
|---|----------|------|-------------------|---------------|----------|--------|
| 1 | S2 | Shops | /shops · StaffDialog | … | … | open |
```

Severity rules:
- **S1 blocker** — data loss or corruption, a wrong money figure, a lock bypassed, a page that crashes to the error boundary. **Stop the sweep, fix immediately, re-verify, then resume.**
- **S2 major** — a feature unusable or showing wrong data. Log, finish the current task, fix before moving to the next task.
- **S3 minor** — copy, spacing, a missing empty state. Log and batch; fix at Task 22.

- [ ] **Step 3: Verify all three logins work**

Sign in as each of GERRY, ADMIN, SHOP in three separate browser profiles (not tabs — sessions must not share cookies).

Expected: GERRY → `/dashboard` (full money picture) · ADMIN → `/dashboard` (money-free) · SHOP → `/shop`.

- [ ] **Step 4: Record the role matrix baseline**

As **ADMIN**, confirm the sidebar shows: Dashboard, Suppliers, Master Inventory, Deliveries & Returns, Stock Alerts, Monthly Count, Movements, Approval Queue, Receivables, Warranties & Serials, Suki Cards, Shops & Employees, Expenses — and **no Reports**. Open the avatar menu: it must show "Admin" and **no Settings** link.

- [ ] **Step 5: Commit the bug log skeleton**

```bash
git add docs/superpowers/plans/
git commit -m "docs: QA sweep plan + bug log"
```

---

### Task 1: Authentication, recovery, and routing gates

**Surface:** `app/(auth)/login/{page,login-form}.tsx` · `app/auth/callback/route.ts` · `app/auth/reset/**` · `app/page.tsx` · `proxy.ts`

**Preconditions:** Task 0 complete.

- [ ] **Step 1: Login page chrome**

At `/login` signed out, confirm: brand header "Gerwin Trading / Inventory & Approvals", form heading **"Welcome back"**, subtitle "Sign in with the account the owner created for you.", Email + Password fields, "Forgot password?" link.

- [ ] **Step 2: Validation and failure copy**

| Action | Expected |
|---|---|
| Submit empty | Inline errors on both fields; red border/ring (`aria-invalid`) |
| `notanemail` in Email | "Valid email required"-style inline error |
| Correct email, wrong password | Server error message, fields keep their values, no redirect |

- [ ] **Step 3: Role routing**

Sign in as each role and confirm the landing route: GERRY/ADMIN → `/dashboard`, SHOP → `/shop`. Then, while signed in, manually visit `/login` — expect an immediate redirect back to the correct home (not a second login form).

- [ ] **Step 4: Cross-role URL gates (all ❌)**

| Signed in as | Visit | Expected |
|---|---|---|
| ADMIN | `/reports` | ❌ redirected to `/dashboard` |
| ADMIN | `/settings` | ❌ redirected to `/dashboard` |
| ADMIN | `/expenses/reports` | ❌ redirected to `/dashboard` |
| SHOP | `/dashboard` | ❌ redirected to `/shop` |
| SHOP | `/master-inventory` | ❌ redirected to `/shop` |
| SHOP | `/settings` | ❌ redirected to `/shop` |
| Signed out | `/dashboard` | ❌ redirected to `/login` |

- [ ] **Step 5: Forgot-password dialog**

Open "Forgot password?", confirm the visible `Email` label + placeholder `you@example.com`. Submit blank → inline error with `role="alert"`. Submit a valid address → success state naming the address.

- [ ] **Step 6: Deactivated account is refused**

As GERRY → Settings → Admins → deactivate the ADMIN account. In the ADMIN profile, click any nav item.

Expected: bounced to `/login`; signing in again shows **"This account has been disabled. Talk to the owner."** ❌ Reactivate afterwards.

- [ ] **Step 7: Log findings and commit**

```bash
git add -A && git commit -m "qa: task 1 auth + routing gates"
```

---

### Task 2: App shell, navigation, badges, and the mobile sheet

**Surface:** `components/shell/{app-shell,nav-badges,approvals-badge,notification-bell,scroll-to-top}.tsx`

**Preconditions:** Task 0.

- [ ] **Step 1: Sidebar structure and active state**

As GERRY, confirm the five groups (OVERVIEW, INVENTORY, SALES & SERVICE, ADMINISTRATION) and that navigating to `/shop/record-sale`-style nested routes highlights the *most specific* item only (`/shop` must not stay lit while on a child route).

- [ ] **Step 2: Count badges are correct and live**

Note each badge number (Suppliers, Deliveries & Returns, Stock Alerts, Approval Queue, Receivables, Warranties & Serials). With the SHOP window beside it, submit a batch from `/shop/submissions`.

Expected: the Approval Queue badge increments **without a manual refresh** (realtime), within a few seconds.

- [ ] **Step 3: Notification bell**

Open the bell. Confirm: aria-label reads "Notifications, N unread"; the count badge caps at **"9+"**; unread rows are tinted with a blue dot and bold title; timestamps are relative ("2 hours ago"); the list caps at 30. Click a notification → it routes to the mapped page. Click "Mark all read" → dots clear and the badge disappears.

- [ ] **Step 4: Bell empty state**

After marking all read and deleting remaining rows is impractical, simply confirm the empty copy exists in `notification-bell.tsx` ("Nothing yet — stock alerts show up here.") and note whether it can be reached. If unreachable with seeded data, tick and move on.

- [ ] **Step 5: Mobile sheet (390 px)**

DevTools → iPhone 14 Pro Max. Tap the burger.

Expected: sheet slides from the left with the Brand block and full nav, badges render, **no error boundary** (this was the 2026-08-01 duplicate-channel crash — regression check). Tap a nav item → sheet closes and navigates.

- [ ] **Step 6: Mobile notification panel**

Still at 390 px, tap the bell.

Expected: the panel's right edge meets the screen's right edge with an even ~12 px gutter on both sides, it is anchored under the bell (not floating mid-screen), and the list scrolls inside the panel without the last row hiding under browser chrome.

- [ ] **Step 7: Theme toggle and scroll-to-top**

Toggle light/dark on three different pages — confirm no unreadable text (badges, muted captions, table headers) in either theme. Scroll a long list (`/movements`) past ~400 px → the back-to-top button appears; click → smooth scroll to top; it must be hidden when printing.

- [ ] **Step 8: User menu**

Confirm avatar initials, name (hidden below `sm`), the label block showing name over role/shop, Support link, and Sign out. Sign out → `/login`, and the back button must not restore an authenticated page.

- [ ] **Step 9: Log findings and commit**

---

### Task 3: Suppliers — Directory and Payables

**Surface:** `app/(owner)/suppliers/{page,supplier-tabs,suppliers-table,payables-view}.tsx`

**Preconditions:** Task 0. Run as **ADMIN** (this area is office-tier), then spot-check as GERRY.

- [ ] **Step 1: Directory table controls**

Search `Search suppliers…` filters rows; sort by Supplier and by **We owe**; confirm the utilisation colouring (red ≥100 %, amber ≥80 %); pagination bar hides when ≤10 rows and otherwise reads "1–20 of 45".

- [ ] **Step 2: Add Supplier — happy path**

Click `Add Supplier`. Fill `Name` = `QA Supply Co`, `Contact` = `09171234567`, `Notes` = `QA sweep`, `Credit limit ₱` = `50000`, `Payment terms (days)` = `30`, `Terms note` = `2% if paid in 10 days`. Save.

Expected: toast "Supplier added", row appears, We-owe shows ₱0.00.

- [ ] **Step 3: Add Supplier — validation (all ❌)**

| Field | Input | Expected |
|---|---|---|
| Name | blank | ❌ "Name is required" |
| Credit limit ₱ | `abc` | ❌ "Enter a valid ₱ amount" |
| Payment terms | `400` | ❌ "0–365 days" |
| Payment terms | `-1` | ❌ "0–365 days" |

- [ ] **Step 4: Edit and remove**

Row menu → `Edit` → change the contact → Save → toast "Supplier updated". Row menu → `Remove` → confirm dialog titled `Remove supplier "QA Supply Co"?` with body "Past receivings keep their history." → confirm → toast "QA Supply Co removed" and the row disappears.

- [ ] **Step 5: Payables tab**

Open Payables. Confirm the tab label carries a red overdue count badge. Confirm the by-supplier table lists **all** suppliers (including those owing nothing) and that a supplier with no credit limit shows the text **"No limit"** rather than a bar.

- [ ] **Step 6: Supplier detail and payment**

Open a supplier with a balance. Confirm the header counter "N transaction(s) · N open", the "Transaction history" heading, that fully-paid receivings still appear (dimmed), and that `Pay this` renders **only** on rows with a balance > 0.

- [ ] **Step 7: Record a payment**

Click `Pay this` on an open receiving. Type `1000abc` into the amount → confirm non-numeric characters are stripped. Attach a receipt photo. Save.

Expected: dialog cannot be dismissed while saving; success toast reads "Paid — ₱1,000.00 applied" (targeted) or "Paid — allocated across N receivings, oldest first" (FIFO); the balance drops by exactly the amount; the aging bucket updates.

- [ ] **Step 8: Payables empty state**

Filter to a supplier with no receivings → expect "No receivings from this supplier yet."

- [ ] **Step 9: Log findings and commit**

---

### Task 4: Suppliers — Receiving (the largest form in the app)

**Surface:** `app/(owner)/suppliers/receiving-view.tsx` (2 076 lines) — 5 dialogs

**Preconditions:** Task 3 (a supplier exists). Run as **ADMIN**.

- [ ] **Step 1: Open the form and check the gates**

Click `New Receiving`. Before picking a supplier, confirm the caption placeholder "Outstanding balance appears here." and that the Payment section is **not** rendered.

- [ ] **Step 2: Supplier is required (❌)**

Add a part line and click `Receive stock` with no supplier.

Expected: ❌ "Pick the supplier — stock always comes from someone".

- [ ] **Step 3: Supplier context loads**

Pick a supplier. Expected: caption reads "Owed now ₱X of ₱Y limit · Z% used · net-N terms", and the Payment section appears with a live "Receiving total".

- [ ] **Step 4: Part lines — existing product**

`Add part` → open the combobox → confirm the search placeholder `Search name, SKU, or scan barcode…` and the pinned `New product…` item. Pick an existing part.

Expected: the line's `Unit cost ₱` **auto-fills** from the part's current cost, and the caption shows last-paid context ("Last paid to X … cheapest paid elsewhere …").

- [ ] **Step 5: Keyboard flow**

With focus in `Unit cost ₱`, press **Enter**.

Expected: a new blank part line is added (this is the fast-entry path used at the counter).

- [ ] **Step 6: New product dialog**

In the combobox choose `New product…`. Confirm fields: `Name *`, `Category`, `Unit`, `SKU`, `Barcode` + checkbox "Generate a GT barcode (unbranded goods)", `Selling price ₱ *`, `Reorder level`.

Test: tick the GT checkbox → the Barcode input disables and its placeholder flips to "will be generated". Submit with a blank name → ❌ toast "The new product needs a name". Submit with no price → ❌ toast "Enter a selling price (₱)". Then fill correctly → the line shows a `NEW` badge and the caption "New product — created with this receiving".

- [ ] **Step 7: Bulk new products dialog**

Click `Bulk new products`. Confirm it starts with 3 cards, each with `Auto (GT)` checkbox and **no SKU field**. Put qty `0` in row 2 → ❌ toast naming the row ("Row 2 (X): qty must be positive"). Fix and submit → toast "N line(s) added to the receiving".

- [ ] **Step 8: Engine lines**

`Add engine` → fill `Serial`, pick a model, set Condition/Cost/Price/Warranty. Click the **Duplicate line** button (title "Same model, next serial").

Expected: a new line with the same model and the next serial number. Submit with a blank serial → ❌ refused.

- [ ] **Step 9: New engine model dialog**

Choose `New model…`. Submit blank → ❌ toast "Brand and model are required". Fill Brand + Model → the line shows a `NEW` badge.

- [ ] **Step 10: Payment — paid in full**

Set Payment status `Paid in full`, method `Cash`. Confirm the `Reference no.` placeholder reads "Optional" and no due date is demanded. Save → success.

- [ ] **Step 11: Payment — partial (validation)**

New receiving, status `Partially paid`. Enter an amount **equal to the total** → ❌ "A partial payment must be less than the total — use Paid in full". Enter `0` → ❌ refused. Enter a valid amount → live "Balance: ₱X" appears, and the caption "This adds ₱X to what you owe <supplier>."

- [ ] **Step 12: Due date is required when not paid in full (❌)**

With `Partially paid` and no due date → click Receive stock → ❌ "Pick a due date — use the presets or the calendar". Click the `3 months` preset → the DatePicker fills. Confirm the helper line references the supplier's net-N terms.

- [ ] **Step 13: Reference placeholder switches by method**

Change method through Cash / Bank transfer / GCash / Cheque / Other and confirm the `Reference no.` placeholder changes ("Optional" / "Transaction / ref no." / "Cheque no.").

- [ ] **Step 14: Credit-limit override**

Pick a supplier with a low limit and add lines exceeding it. Confirm the banner turns red with an `AlertTriangle` and a **required** `Reason for going over` textarea. Submit blank → ❌ "This exceeds the credit limit — give a reason to proceed". Fill a reason → save succeeds and the reason is recorded on the receiving.

- [ ] **Step 15: Atomicity**

Create a receiving with 2 existing parts, 1 inline-new part, and 1 engine, partially paid. Save.

Expected: **one** receiving row, all 4 lines, the new part in Master Inventory, master stock up by the received quantities, the payable balance = total − paid. Verify no partial state exists if you refresh.

- [ ] **Step 16: Post-save print labels**

Confirm the post-save offer to print labels routes to `/master-inventory/labels?ids=…` with the new product preselected.

- [ ] **Step 17: Detail dialog and deep link**

Row action `View` → confirm the spinner while lines load, an `Engine` badge on engine lines, and the footer "N line(s) · Total cost: ₱X". Copy the URL with `?view=<id>`, reload → the dialog opens directly.

- [ ] **Step 18: Empty states**

With no lines added, confirm "No part lines yet — 'Add part', or 'Bulk new products' for a carton of brand-new items." and "No engine lines yet — click 'Add engine'."

- [ ] **Step 19: Log findings and commit**

---

### Task 5: Master Inventory — Products, Engines, Categories, Labels

**Surface:** `app/(owner)/master-inventory/**` — `parts-table`, `engines-table`, `part-form-dialog`, `engine-form-dialog`, `add-product-dialog`, `add-engine-dialog`, `fitment-dialog`, `merge-dialog`, `supplier-prices-dialog`, `reference-data-dialogs`, `categories/`, `labels/`

**Preconditions:** Task 4 (products exist). Run **both** as ADMIN and GERRY — the price and retire locks diverge.

- [ ] **Step 1: Products table**

Confirm columns Item / Category / Barcode / Master Qty / Cost / Price / Margin / Supplier / actions. Confirm a `Below cost` destructive badge appears wherever price ≤ cost, and the Margin badge is destructive when negative and "—" when price is 0.

- [ ] **Step 2: Card view**

Toggle to cards. Confirm: `Out of stock` badge with a **grayscale** image at qty 0, `Low` badge at qty ≤ reorder level, the "N% margin" caption, and the "Stock — N unit" footer. Search for gibberish → `Nothing matches "…"` empty state.

- [ ] **Step 3: Edit product as GERRY**

Row menu → `Edit`. Confirm the description "Costs are owner-only — employees see selling price only." Change `Cost ₱` and `Price ₱` → Save → values update.

- [ ] **Step 4: Price lock as ADMIN (❌)**

Same dialog as ADMIN.

Expected: ❌ `Cost ₱` and `Price ₱` inputs are **disabled** with the hint "Only the owner can change cost and selling price." Change the name only → Save succeeds and the prices are unchanged.

- [ ] **Step 5: Photo upload**

In the edit dialog, use the drop-zone: drag an image in (confirm the zone highlights), then use `Choose photo`. Confirm the before→after byte + `W×H` readout and the hint "Optional — JPG/PNG up to 10MB. Compressed to ~40KB in your browser." Save → the photo appears in card view.

- [ ] **Step 6: Photo remove and undo**

Re-open, click `Remove` → confirm the warning "Photo will be removed on save." and that it flips to `Undo remove`. Click Undo → warning clears. Then actually remove → Save → the tile falls back to the placeholder.

- [ ] **Step 7: Generate internal barcode**

On a product with no barcode, row menu → `Generate internal barcode`.

Expected: toast "Barcode GT######## assigned to <name>", the Barcode column fills, and the menu item disappears (replaced by `Print label`).

- [ ] **Step 8: Fitment dialog**

Row menu → `Fitment`. Confirm the description mentioning employees see "fits Yamaha 40HP". Tick 2 models → Save → the menu item shows the count `Fitment (2)`.

- [ ] **Step 9: Suppliers & prices dialog**

Row menu → `Suppliers & prices`. Confirm rows sorted cheapest-first, a `Last paid` cell reading **"never"** where applicable, provenance labels ("Paid · MMM d, yyyy" / "Quoted · … (stale)"), and that `Make preferred` is hidden on the row that already is preferred. Click `Make preferred` on another → the Supplier column on the table updates.

- [ ] **Step 10: Add product (supplier-less)**

Toolbar `Add product`. Confirm the description "Enters stock immediately with no supplier and no debt…" and the supplier helper "Supplier is attribution only…". Create with qty **0** and price > cost → succeeds, product appears with 0 stock, **no** payable created. Then try price ≤ cost → ❌ "Selling price must be above cost".

- [ ] **Step 11: Add engine**

Toolbar `Add engine`. Confirm `model_mode` defaults to "new" if the catalog has no models. Create with a new model → the serial appears in the Engines tab with status `In master`.

- [ ] **Step 12: Engines tab**

Confirm the **Condition** and **Status** columns, the status badges (In master / At shop / Sold / Returned) with a `ShopBadge` naming the holder, the `Below cost` badge, and in card view the grayscale image when sold.

- [ ] **Step 13: Retire lock as ADMIN (❌)**

As ADMIN, open a product row menu and an in-master engine row menu.

Expected: ❌ **no** `Remove product`, ❌ no `Remove engine`, ❌ no `Merge duplicates` toolbar button, ❌ no retire option in the Models manager. Everything else (Edit, Fitment, Barcode, Prices) is present.

- [ ] **Step 14: Retire as GERRY**

As GERRY, `Remove product` on a QA-created product → confirm dialog → removed from lists. Confirm its history (any receiving line) still exists.

- [ ] **Step 15: Merge duplicates**

As GERRY, toolbar `Merge duplicates`. Confirm the sources list renders **only after** a survivor is chosen, each source shows a stock `Badge` (warning-bordered when > 0), and a source holding stock is blocked with the summary "N selected duplicate(s) can't be merged yet…". Merge a zero-stock duplicate → succeeds; the survivor's Suppliers & prices now rolls up both.

- [ ] **Step 16: Models manager**

Engines view → `Models`. Confirm the empty state "No engine models yet — they're created on a receiving.", that there is **no footer/Cancel** (X only), and that renaming to an existing brand+model surfaces ❌ "That brand + model already exists."

- [ ] **Step 17: Categories tab**

`/master-inventory/categories`. Create a category → appears immediately in a product picker (verify in the Add product dialog). Rename it. Retire it → confirm the dialog copy differs when usage > 0 ("N product(s) keep it as their category."). Create a category whose name matches a retired one → expect the retired one to be restored rather than duplicated.

- [ ] **Step 18: Labels tab**

`/master-inventory/labels`. Confirm the pick-list empty state "No barcoded items found." and the preview empty state "Tick items on the left to preview their labels here." Tick 3 items → barcodes render (Code128). Print preview → **only the label sheet** prints (the picker card is `print:hidden`).

- [ ] **Step 19: Log findings and commit**

---

### Task 6: Deliveries & Returns

**Surface:** `app/(owner)/deliveries/{deliveries-view,transit-panel,transfers-panel}.tsx` · `[id]/note`

**Preconditions:** Tasks 4–5 (master stock exists). ADMIN runs this; SHOP confirms arrival.

- [ ] **Step 1: Pre-shop gate**

Open New Delivery. Before picking a shop, confirm "Pick a shop above to start adding items." and that both line sections and the submit button are hidden.

- [ ] **Step 2: Build and send a delivery**

Pick Shop 1. `Add part` → pick a part → set qty. Confirm typing a qty above availability **re-clamps** to what's on hand, and that blanking the qty normalises to "0" on blur. Add an engine via `Pick engines`. Send.

Expected: toast "Sent — in transit until the shop confirms what arrived"; master qty drops; shop qty **unchanged**; the delivery appears under In Transit.

- [ ] **Step 3: Delivery note (owner copy)**

Open `/deliveries/[id]/note`. Confirm the letterhead from Settings, per-line **cost and selling price**, "Total at cost / at selling", "Prepared by <name>", and the shop's location line. While in transit the Qty column shows the **sent** quantity.

- [ ] **Step 4: Shop confirms with a discrepancy**

As SHOP → `/shop/deliveries`. Confirm the card header "N item(s) on the way", the source label "from Admin / Master", and the sent date. Enter **good 4 / damaged 1 / missing 1** on a 6-unit line, attach a damage photo, submit.

Expected: the damaged input border turns `warning`; toast "4 good · 1 damaged · 1 missing — Admin will review the damaged & missing."; shop stock increases by **4 only**.

- [ ] **Step 5: Over-count refusal (❌)**

Try good + damaged greater than sent → ❌ "Good + damaged can't be more than was sent". Also confirm confirming twice is impossible (one-shot).

- [ ] **Step 6: Shop cannot resolve (❌)**

Confirm the shop UI offers **no** write-off, no return, no reject — only counts and a note.

- [ ] **Step 7: Owner resolves the discrepancy**

As ADMIN → Deliveries → In Transit → "Needs your decision". Open Resolve. Confirm the qty/cause **prefill** from what the shop flagged (damaged → cause `Damaged`), that resolution defaults to **Write off**, and the description appends "(1 flagged damaged)". Resolve 1 as **Return to master** and 1 as **Write off**.

Expected: master +1; total owned drops by exactly 1; movement types are `transit_return` and `transit_writeoff` (verify in Task 13).

- [ ] **Step 8: Delivery note after confirmation**

Re-open the note → the Qty column now shows **`qty_received`**, and both totals use that quantity.

- [ ] **Step 9: Shop-to-shop transfer**

As SHOP → `/shop/transfers` → Send stock → pick Shop 2, add items → request. As ADMIN → Deliveries → Transfers & Returns → **Approve**. As Shop 2 → confirm arrival. Print the Stock Transfer Slip from `/transfer/[id]/slip`.

Expected on the slip: From → To, lines with unit labels, engine SNs, letterhead; the Approved column is blank if not yet approved.

- [ ] **Step 10: Transfer reject and cancel**

Request another transfer → as ADMIN **Reject** with a note → the shop sees the note. Request a third → as SHOP **Cancel** while `requested` → it disappears. Confirm both dialogs lock while busy.

- [ ] **Step 11: Return to Admin**

As SHOP → Transfers → Return to Admin → pick parts (good 1 / damaged 1) + reason → request. As ADMIN → **Approve**.

Expected: good lands in master; damaged becomes an **approved loss at cost**; print the Return Slip at `/return/[id]/slip` (lines split Good/Damaged, no cost columns).

- [ ] **Step 12: Empty states**

Confirm "No transfers waiting for approval.", "No returns waiting for approval.", "Nothing moving between shops right now.", "Nothing waiting to be confirmed.", and the history "No deliveries or returns yet." where reachable.

- [ ] **Step 13: Log findings and commit**

---

### Task 7: Stock Alerts and the Purchase List

**Surface:** `app/(owner)/stock-alerts/{stock-alerts-view,requests-panel}.tsx` · `purchase-list/` · `request/[id]/receipt/`

**Preconditions:** seeded low stock + 60 open requests.

- [ ] **Step 1: Master and All-shops tabs**

Confirm the `KindBadge` (Part / Engine) in the Product cell on both tables, and the empty messages "Master stock is healthy — nothing to buy." / "No shop shortages."

- [ ] **Step 2: Supplier filter drives the print link**

On the Master tab, pick a supplier in the dropdown beside the search. Confirm the table narrows **and** the Print link becomes `?supplier=<id>`. Print → the sheet contains only that supplier's items, with letterhead and sign-off. Reset to "All suppliers" → the combined sheet prints, grouped by supplier, with a **"No supplier set"** block sorted last.

- [ ] **Step 3: Purchase list details**

Confirm per-supplier "N item(s)" counts, the cheapest-price suggestion in both forms ("Cheapest: <supplier> — Paid ₱X · date" / "Best known price here — …", "(stale)" where applicable), and the footnote "Order qty = shortfall + 2 buffer…". Visit with a bogus `?supplier=zzz` → falls back to the full sheet.

- [ ] **Step 4: Requests tab**

Confirm the badge = open count, the 2-column grid of open cards, per-line shop notes in "(note)", and the empty states ("No open requests." with an Inbox icon / "Nothing reviewed yet."). Confirm reviewed cards show counts but **do not** list items.

- [ ] **Step 5: New-product request lines**

Find (or create from the shop) a request containing a free-text custom line. Confirm it is badged **"New product"** on the card and on the printed receipt.

- [ ] **Step 6: Print the request receipt**

`Print request` → `/stock-alerts/request/[id]/receipt`. Confirm the itemised list (parts + engines), the status printed capitalised, shop location + requester name, and signature lines.

- [ ] **Step 7: Convert to delivery**

Click `Convert to delivery`.

Expected: navigates to `/deliveries?request=<id>` with **every** requested line pre-filled, split into **Available in master** (editable, qty capped, with a "requested N, only M available" caption) above **No master stock** (disabled, informational). Custom "New product" lines appear as an informational "create via Receiving first" block and are **never** in the deliver payload. If nothing is available, the Deliver button is disabled. Confirm the warning line "N requested item(s) have no master stock yet — buy from a supplier first."

- [ ] **Step 8: Dismiss a request**

Dismiss with a reason → toast "Request dismissed — the shop was told"; the shop sees it in their history.

- [ ] **Step 9: Reorder levels and per-shop overrides**

Open the Reorder levels tab. Confirm the search resets the scroll batch to 40, that `-1` is refused with ❌ "Reorder level must be 0 or more", and a valid save toasts "<name> updated". In Overrides, confirm the empty state "No overrides — every shop uses the product defaults.", then add and remove one (toasts "Override saved" / "Override removed — back to the default").

- [ ] **Step 10: Log findings and commit**

---

### Task 8: Approval Queue and Reviewed History

**Surface:** `app/(owner)/approvals/{approvals-view,approval-tabs,reviewed-history,reviewed-detail-sheet}.tsx`

**Preconditions:** a shop batch pending (Task 18 creates one; the seed also provides several).

- [ ] **Step 1: Tabs and empty states**

Confirm the four tabs and their empty panels: "Nothing waiting — you're all caught up." / "No sales awaiting approval." / "No losses awaiting approval." / "No expenses awaiting approval."

- [ ] **Step 2: Batch card anatomy**

Confirm the header caption with per-batch sale/loss/expense counts, the sales total, and "· N questioned (excluded from approve-all)". Confirm badges: "Engine sale", "Questioned" (card gets a warning border), per-line "Engine", the negotiation strip (Asking / Floor / "₱X off" / **"at floor"**), and the suki badge "Suki <card_no> · −₱X".

- [ ] **Step 3: Approve a single sale**

Approve one sale.

Expected: toast "Sale approved — stock deducted"; the shop's stock drops **now** (not before); COGS is frozen (verify in the detail sheet, Step 8).

- [ ] **Step 4: Question and resolve**

Question a loss with a note (confirm the placeholder "e.g. Bakit 3 pcs? Isa lang nabenta kanina…" and that Question **requires** a note — blank is ❌). As SHOP, see the questioned item and its note. Return as ADMIN and approve it.

- [ ] **Step 5: Reject**

Reject an item. Confirm the note is **optional** here (placeholder "Reason (optional)") and the toast "Rejected".

- [ ] **Step 6: Approve-all**

On a batch with no questioned items, click Approve all → toast "Batch approved — N sale(s), N loss(es) and N expense(s)". Confirm a batch containing a questioned item excludes it. Confirm legacy `legacy-<shop>` groups have **no** Approve-all button.

- [ ] **Step 7: Approve an expense**

Approve a shop expense whose category is already active → confirm the static line "Category: <badge> — counts in expenses and P&L once approved." Approve one with a **proposed** category → confirm the Select appears; approve as-proposed → the category activates. Repeat with a **remap** → the proposal never activates.

- [ ] **Step 8: Engine sale → warranty**

Approve an engine sale.

Expected: the serial flips to `sold`, a warranty row is created automatically (verify in Task 10), and the movement is recorded.

- [ ] **Step 9: Realtime**

With the SHOP window beside it, submit a new batch → the queue updates within seconds **without refresh**, and a toast fires only when a row actually flips to `pending`.

- [ ] **Step 10: Reviewed History**

Switch to Reviewed. Filter by shop / type / status / date / search. Confirm the range counter "1–20 of N", the two distinct empty rows ("Nothing matches those filters." vs "Nothing reviewed yet."), and that **any filter change resets paging to page 1**.

- [ ] **Step 11: Detail sheet**

Click a row → the slide-over opens with `?item=<type>:<id>` in the URL. Confirm the loading state, then the sections: "Resulting stock movements" (with its empty state "No stock moved (nothing was approved)."), owner-only per-line **cost + margin** on a sale, the inline receipt image on an expense, and the **Before → After balance** block with a "Settled" badge on a payment. Reload the URL directly → the sheet re-opens on the same item.

- [ ] **Step 12: Bad deep link**

Visit `?item=sale:00000000-0000-4000-8000-000000000000` → expect the red error panel reading `Not found` (not a crash).

- [ ] **Step 13: Log findings and commit**

---

### Task 9: Receivables and the Gerry-only payment void

**Surface:** `app/(owner)/receivables/{receivables-view,receivable-tabs}.tsx` · `app/(shop)/shop/receivables/`

**Preconditions:** an approved partial-payment sale (Task 18 Step 4).

- [ ] **Step 1: Owner list**

As GERRY, confirm the Open / Fully paid tabs, their empty states ("No outstanding balances." / "Nothing fully paid yet."), per-shop and per-customer totals, and the "N voided" counter in the totals strip.

- [ ] **Step 2: Card badges**

Confirm the "Settled" badge at balance ≤ 0 and **"Sale <status>"** when the underlying sale isn't approved yet.

- [ ] **Step 3: Shop records a payment**

As SHOP → `/shop/receivables` → Record Payment. Confirm every field resets on open and the payer is prefilled from the debtor. Submit blank amount → ❌ "Enter the amount the customer paid". Amount above the balance → ❌ "That's more than the ₱X balance". Blank payer → ❌ "Enter who paid". Valid → toast `Payment recorded — balance now ₱X` (or "Fully paid — utang settled").

Expected: the payment posts **immediately** — it does **not** enter the approval queue.

- [ ] **Step 4: Shop cannot void (❌)**

In the shop's payment history, confirm there is **no** void button — only the note "Recorded a payment by mistake? Call the owner…".

- [ ] **Step 5: Admin cannot void (❌)**

As ADMIN → `/receivables` → expand a sale's payment history → ❌ no void icon.

- [ ] **Step 6: Gerry voids**

As GERRY, expand the history → click the void icon → confirm the dialog names the amount and customer → confirm.

Expected: toast "Payment voided — balance restored"; the entry stays **struck-through** in both the owner and shop histories; the balance rises by exactly the amount; the sale leaves "Fully paid" if it was settled; the office receives an alert.

- [ ] **Step 7: CSV export**

Export CSV → confirm it downloads and the columns match the on-screen rows.

- [ ] **Step 8: Log findings and commit**

---

### Task 10: Warranties, claims, and physical card numbers

**Surface:** `app/(owner)/warranties/warranties-view.tsx` · `app/(shop)/shop/warranties/warranties-view.tsx`

**Preconditions:** Task 8 Step 8 (an approved engine sale).

- [ ] **Step 1: Owner registry**

Confirm the columns include **Status** (Active/Expired) and **Card no.** (mono, "—" when unset). Confirm the empty state "No warranties yet — they appear automatically when you approve an engine sale."

- [ ] **Step 2: No certificate anywhere (❌)**

Confirm ❌ there is **no** print/certificate button on the owner registry, ❌ none on the shop list or its detail dialog, and ❌ none on the Submissions engine-sale row. Visit `/warranties/<id>/certificate` directly → **404**.

- [ ] **Step 3: Shop records a card number**

As SHOP → `/shop/warranties` → on the new warranty click `Record card no.` → type `WC-QA-001` → press **Enter** (it is a real form — the scanner path).

Expected: toast "Card number recorded"; the value renders uppercase and mono; the dialog refuses to close while saving.

- [ ] **Step 4: Duplicate refused (❌)**

Record `wc-qa-001` (different case) on another warranty → ❌ refused as already recorded.

- [ ] **Step 5: Searchable**

Search `WC-QA-001` in the shop's lookup box and in the owner registry search → the warranty is found by card number.

- [ ] **Step 6: Cross-shop isolation (❌)**

As a **different** shop login, search that serial and card number → ❌ nothing found (the shop only sees engines it sold).

- [ ] **Step 7: Owner edits any card number**

As GERRY, edit the card number via the pencil → saves. Clear it with an empty value → toast "Card number cleared" and the cell shows "—".

- [ ] **Step 8: File a claim (repair)**

As SHOP → open a warranty → `File a claim` → resolution **Repair** → issue text (placeholder "e.g. hard to start, smoking, gearbox noise") → submit. Blank issue → ❌ "Describe the issue". Confirm it appears under **My claims** with Cancel available while `requested`.

- [ ] **Step 9: Approve the claim**

As ADMIN → `/warranties` → the claims section → Approve → toast "Claim approved"; the shop's My claims updates.

- [ ] **Step 10: Replace claim**

File a **Replace** claim picking an on-hand engine. Blank replacement → ❌ "Pick a replacement engine". Approve as ADMIN.

Expected: the replacement books out as an approved **loss at cost** (reason `warranty`); the defective unit returns to master as `defective`; the warranty **repoints** to the new serial; the recorded **card number survives**.

- [ ] **Step 11: Refund claim**

File a **Refund** claim. Blank amount → ❌ "Enter the refund amount". Approve → the amount is booked as an approved **company expense** ("Warranty Refunds") and the defective unit returns to master.

- [ ] **Step 12: Reject a claim**

Reject one with a note → toast "Claim declined — the shop was told"; nothing moves.

- [ ] **Step 13: Serials tab and journey**

Open the Serials tab → open an engine's journey. Confirm the loading spinner, the timeline (received → delivered → sold), the green **"Warranty issued — N months"** node, any red claim nodes, and the empty state "No recorded movements for this serial."

- [ ] **Step 14: Log findings and commit**

---

### Task 11: Suki Cards

**Surface:** `app/(owner)/suki-cards/suki-cards-view.tsx`

**Preconditions:** a customer exists.

- [ ] **Step 1: List**

Confirm the **Card no.** (mono) and **Status** (Active/Inactive) columns, the empty state "No cards yet — create one for your first suki.", and that the card description shows the **live** rates from Settings ("X% off engines · Y% off parts").

- [ ] **Step 2: Record a card for an existing customer**

`Record card` → pick a customer via the combobox (confirm the `Check` on the selected row and the phone shown) → enter a barcode number → save → toast "Card <no> recorded — the suki can use it now".

- [ ] **Step 3: Record for an inline-new customer**

Repeat, creating the customer inline. Confirm the new customer is created and linked.

- [ ] **Step 4: One active card per customer (❌)**

Record a second card for the same customer → ❌ refused (one active card per customer).

- [ ] **Step 5: Deactivate / reactivate**

Deactivate → toast "<card_no> deactivated"; status flips. Reactivate → toast "<card_no> reactivated".

- [ ] **Step 6: Replace with new card**

Use `Replace with new card` → confirm the two-step toasts ("<card_no> deactivated — record the new card number", then the new number recorded). The old card is inactive; the new one active.

- [ ] **Step 7: Per-card usage**

Confirm the usage figures (uses + Σ program discount) update after the suki sale in Task 18 Step 3.

- [ ] **Step 8: No printing (❌)**

Confirm ❌ there is no card-print page (cards are printed externally). `/suki-cards/<id>/print` → 404.

- [ ] **Step 9: Log findings and commit**

---

### Task 12: Monthly Count

**Surface:** `app/(owner)/counts/{counts-list,[id]/count-entry,[id]/sheet}.tsx`

**Preconditions:** a shop with stock.

- [ ] **Step 1: Create a session**

`/counts` → confirm the empty state "No count sheets yet." if applicable. Click create with **no shop selected** → ❌ toast "Pick a shop". Pick a shop → create → toast "Count sheet created — expected quantities frozen".

- [ ] **Step 2: Print the blank sheet**

Open `[id]/sheet` → confirm letterhead, the item list, the engines tick-list (only when the shop holds delivered engines), and the **"Counted by: ____ / Date/time: ____"** signature block. Then open `?blind=1` → confirm the **"BLIND COUNT — expected hidden"** marker and that expected quantities are hidden.

- [ ] **Step 3: Enter counts**

In `[id]`, use the search (confirm `Nothing matches "<query>".`) and the scroll sentinel "Loading more… (n of N)". Enter a **negative** count → ❌ toast "<part>: invalid count" and the whole save aborts. Fix → toast "Counts saved". Confirm the header progress "counted X/Y".

- [ ] **Step 4: Variances**

Enter one deliberate **shortage** and one **overage**. Confirm per-row badges ("Match" / negative / "+N"), shortage rows tinted, and the variance card title "Variances: N shortage(s), M overage(s)" with the overage warning text. Confirm the Send button renders only when shortages > 0.

- [ ] **Step 5: Send shortages to the queue**

Send → toast "N loss(es) sent to the approval queue". Confirm the rows now badge **"Sent to queue"** and the losses appear in the Approval Queue; approve one and confirm stock deducts.

- [ ] **Step 6: List columns**

Back at `/counts`, confirm the Variances cell renders "—" / "All match" / "N flagged" and the Sent-to-queue cell renders "N losses".

- [ ] **Step 7: Log findings and commit**

---

### Task 13: Movements — Journal, Stock Card, Engine History

**Surface:** `app/(owner)/movements/**` · `stock-card/print/`

**Preconditions:** Tasks 4–8 (a full stock lifecycle exists).

- [ ] **Step 1: Journal filters**

Confirm the default date range is **today−30 → today** (never "all time"). Filter by location, type, product, actor, and search. Confirm the empty state "No movements match these filters."

- [ ] **Step 2: Transit rows read correctly**

Find a `transit_writeoff` row. Confirm the Location cell appends **"(never reached a shop)"** and the row is reported at location **transit**, not master. Confirm a loss row appends its **reason** in the Product cell.

- [ ] **Step 3: Deep links**

Click through several rows → each opens its source document (receiving, delivery, sale, loss, return).

- [ ] **Step 4: Stock Card**

Switch to `?tab=ledger`. Confirm the idle state "Pick a product to see its stock card." Pick the QA part × Shop 1 → confirm Opening → running → Closing balances, and hand-verify the closing balance against the shop's on-hand quantity. Pick a period with no movement → confirm "No movements in this period. The opening balance carried straight through." Confirm the standing footnote about transit.

- [ ] **Step 5: Stock card print**

Print → confirm letterhead, the **Notes** box, and the signature line. Visit `/movements/stock-card/print` with **no** `?part=` → **404**.

- [ ] **Step 6: Engine History**

`?tab=engines`. Confirm the idle state "Scan or enter a serial to trace an engine's whole life." Enter a bogus serial → "No engine with serial <X>." Enter the QA engine serial → the full chain (received → delivered → sold), the header card with state badge, **unit cost**, and current shop/customer.

- [ ] **Step 7: Reconciliation spot-check**

Pick any product × location and confirm `Σ movements = stock_levels` by eye against `/shops/[id]/stock`. (The automated proof is `npm test -- --only=movements` in Task 22.)

- [ ] **Step 8: Log findings and commit**

---

### Task 14: Shops & Employees — the area the last sweep skipped

**Surface:** `app/(owner)/shops/{shops-view,actions}.tsx` · `[id]/stock/`

**Preconditions:** Task 0. Run **as ADMIN first**, then GERRY — the credential and close-shop carve-outs are here.

- [ ] **Step 1: Page chrome and empty states**

Confirm the heading "Shops & Employees", the intro "One card per shop — stock at a glance and its single shared login.", and (where reachable) "No shops yet — create the first one." Confirm an inactive shop card renders at `opacity-75`.

- [ ] **Step 2: Create a shop (ADMIN)**

`Add shop` → `Name` = `ZZ QA Branch`, `Location` = `QA Town`. Confirm the placeholders ("Branch 3 — Landing" / "e.g. Poblacion"). Save → the card appears.

- [ ] **Step 3: Map pin**

Edit the shop → use the location picker → drop a pin → Save → re-open and confirm the pin persisted at the same coordinates.

- [ ] **Step 4: Shop colour picker**

Edit → confirm each swatch carries `aria-pressed` and `aria-label="Color {key} — used by {shop}"`, that **taken colours are disabled and name their owning shop**, and that the hint "(neutral — tap a circle to pick, tap again to clear; greyed = taken)" appears only while nothing is selected. Pick a free colour → Save.

Expected: the colour drives the card tile, the map pin, and every `ShopBadge` for that shop across the app (spot-check in Approvals and Warranties).

- [ ] **Step 5: Shop logo upload**

Edit → upload a logo (confirm the helper "Printed on this branch's receipts, in place of the anchor…"). Save.

Expected: the logo appears on that branch's **sale receipt** in place of the anchor (verify in Task 19). Re-open and **remove** the logo → the anchor returns.

- [ ] **Step 6: Logo partial-failure copy**

If an upload fails (throttle the network in DevTools to force it), confirm the toast "Shop saved, but the logo upload failed: …" — i.e. the row saved even though the image did not.

- [ ] **Step 7: Staff — create with photo (the gap from last time)**

On a shop card click Add employee. Confirm the description "The people who work at this shop. A birthday turns on the reminder on the Dashboard and in the nav." Fill `Name` = `Juan Dela Cruz` (placeholder "e.g. Juan Dela Cruz"), pick the shop, set a **birthday of today**, upload a **photo**, add notes. Confirm Save is disabled until name + shop are set. Save.

Expected: the staff row appears on the card with the photo; **today's birthday makes the celebrant card appear on the Dashboard** (verify in Task 17) and in the nav reminder.

- [ ] **Step 8: Staff photo failure aborts**

Force a photo-upload failure → confirm the toast "Photo upload failed: …" **and that the staff record is not written** (this differs from the shop-logo path, which saves the row anyway).

- [ ] **Step 9: Staff edit, deactivate, remove**

Edit the staff member's name and birthday → save. Deactivate → the row renders at `opacity-60`. Remove → it leaves the list. Confirm the staff Shop select lists **all** shops including inactive ones.

- [ ] **Step 10: Staff empty state**

On a shop with no staff, confirm "No employees yet — add the people who work here."

- [ ] **Step 11: Credentials are Gerry-only (❌ as ADMIN)**

As ADMIN, open a shop card's menu.

Expected: ❌ no `Create Login`, ❌ no `Change Credentials`, ❌ no `Close Permanently`, ❌ no `View Reports`. On a shop with no login, the panel shows "No login account yet — the shop can't sign in." followed by **"Only the owner can create the login."** instead of a button.

- [ ] **Step 12: Create a shop login (GERRY)**

As GERRY on `ZZ QA Branch` → `Create Login`. Confirm the description "One shared account per shop — everyone at the shop uses this login." and the account-name placeholder "e.g. Branch 1 Counter". Create with email + password.

Expected: the card's login indicator flips to "login active"; sign in with that account in a 4th browser profile and confirm it lands on `/shop` scoped to that branch.

- [ ] **Step 13: One login per shop (❌)**

Try to create a second login for the same shop → ❌ "This shop already has a login account — each shop gets exactly one."

- [ ] **Step 14: Change credentials**

`Change Credentials` → confirm the description "The shared login everyone at this shop uses…" and the password placeholder "Leave blank to keep the current password." Change the password only → the old password ❌ fails at sign-in, the new one works. Untick "Login enabled" → ❌ that shop can no longer sign in. Re-enable.

- [ ] **Step 15: Close shop is Gerry-only and blocks on unsettled state**

As GERRY, try to close a shop **holding stock** → confirm the blocked dialog listing blockers with the copy "Nothing returns to master automatically — settle these first so the audit trail stays truthful:". Then close `ZZ QA Branch` (empty) → confirm the clear-state description and that it disappears from lists and delivery targets while its history remains.

- [ ] **Step 16: Admin cannot close (❌)**

As ADMIN, attempt the same via the UI (control absent) — and confirm the database refuses if the action is reached any other way. Expected message: "Only the owner can close or reopen a shop".

- [ ] **Step 17: Colour released on close**

After closing, confirm its colour becomes selectable again for another shop.

- [ ] **Step 18: Read-only shop stock view**

Open `/shops/[id]/stock`. Confirm the back button, the title "{shop} — Stock", the subtitle noting read-only, **both** the parts and **engines card views** (engine tiles with `SN`, condition, cost/gross), the `Out of stock` / `Low` badges, the "N of M items" counter, and the empty states. Visit a closed shop's id → **404**.

- [ ] **Step 19: Log findings and commit**

---

### Task 15: Expenses — log, categories, proposals, reports

**Surface:** `app/(owner)/expenses/{expenses-view,categories/categories-view,reports/}.tsx`

**Preconditions:** shop expenses pending (seeded).

- [ ] **Step 1: Record an expense (ADMIN)**

`Record expense` → confirm the description "Operating costs — fuel, wages, utilities, rent, misc. Stock purchases belong in Receiving, not here." Fill description (placeholder "e.g. Gas for Roxas delivery run"), paid-to ("e.g. Shell, Mang Tony"), amount, category, scope. Save.

- [ ] **Step 2: Amount validation (❌)**

Enter `0` → ❌ toast "Enter a valid ₱ amount". Enter a negative → ❌ same.

- [ ] **Step 3: Receipt upload**

Attach a receipt. Confirm the button reads **"Processing…"** and disables during WebP conversion, and that re-picking the *same* file works (the input resets). Save → the receipt icon appears on the row; click it → the viewer opens (confirm the spinner and, if the signed URL fails, the grey fallback tile).

- [ ] **Step 4: Scope pairing**

Set scope **Shop** with no shop → ❌ refused. Set scope **Company** → confirm the shop select shows "—" and is not required. Confirm the delivery picker defaults to "Not delivery-related" and narrows to the chosen shop only when scope=shop.

- [ ] **Step 5: Void is Gerry-only (❌ as ADMIN)**

As ADMIN, open a row's kebab → ❌ **Edit only, no Void**. Confirm the disabled kebab on a pending shop claim carries `aria-label="Reviewed on the Approval Queue"` and the tooltip "A shop claim under review is decided on the Approval Queue".

- [ ] **Step 6: Void as GERRY**

As GERRY, void an expense → confirm the dialog copy ("It disappears from lists and reports. Its receipt photo is removed.") → confirm.

Expected: the row leaves the list and reports; the receipt object is deleted.

- [ ] **Step 7: Editing a pending shop claim is refused (❌)**

Try to edit a `pending` shop-sourced expense → ❌ "This shop claim is under review — decide it on the Approval Queue".

- [ ] **Step 8: Filtered print**

Apply filters (date range + category + scope) → click `Print` (tooltip "Print the rows currently shown").

Expected: the sheet prints **exactly the filtered rows, unpaginated**, with the active-filter line, the tfoot "Approved total (N row(s) shown)", the closing footnote, and — with an impossible filter — the empty row "No expenses match the current filters."

- [ ] **Step 9: Categories**

`/expenses/categories` → create (confirm "Lower order numbers appear first in pickers."), rename, and remove one. Confirm the remove copy differs by usage ("N expense(s) keep this category…" vs "It can no longer be picked; history stays intact.").

- [ ] **Step 10: Shop-proposed categories**

Confirm the "Proposed by shops (N)" block with its explainer. On one proposal use **Rename→approve**; on another use **Merge into an existing category** (confirm the description "Its N expense(s) move to the category you pick; the proposal is retired…"); on a third try **Dismiss while expenses still use it** → ❌ "N expense(s) still use this proposal — merge it into an existing category instead". Confirm all four buttons disable for a row while its action runs.

- [ ] **Step 11: Expense reports (GERRY only)**

`/expenses/reports` → confirm the charts, their empty states ("No expenses in this range." / "No shop-scoped expenses in this range."), that the CSV button **disables** when there are no rows, and the cost-of-business card's read-only caveat. As ADMIN → ❌ the Reports tab is absent and the URL redirects.

- [ ] **Step 12: Log findings and commit**

---

### Task 16: Settings (Gerry-only) — six sections

**Surface:** `app/(owner)/settings/{settings-view,business-section,account-section,admin-accounts-section,alerts-section,notifications-section,system-section}.tsx`

**Preconditions:** GERRY session.

- [ ] **Step 1: Tabs and fallback**

Confirm six tabs (Business, Account, Admins, Alerts, Notifications, System) and that an unrecognised `?tab=zzz` silently falls back to **Business**.

- [ ] **Step 2: Business identity**

Change `business_name` to `ZZ QA Trading`, set address, phone, email, TIN (helper: "Taxpayer Identification Number, printed on the sale receipt."), and receipt footer (placeholder "e.g. Salamat po! Come again."). Save.

Expected: the new name appears on **every** document — sale receipt, delivery note, count sheet, purchase list, stock card (verify in Task 19). **Restore the original name afterwards.**

- [ ] **Step 3: Defaults**

Set `default_warranty_months` to a non-integer → ❌ toast "Warranty months must be a whole number". Set a valid value → an engine sale approved afterwards uses it.

- [ ] **Step 4: Account — change password**

Test each rule (each a toast): under 8 chars ❌ · no digit ❌ "must contain both a letter and a number" · mismatch ❌ "The two new passwords don't match" · same as current ❌ · wrong current password ❌ "That's not your current password." Then change it successfully → toast "Password changed. Use it next time you sign in." **Update `TEST_OWNER_PASSWORD` in `.env.local` immediately.**

- [ ] **Step 5: Account — change email**

Invalid email ❌ · mismatch ❌ "The two email addresses don't match" · same as current ❌ "That's already your email address". (Do **not** complete a real email change during QA.)

- [ ] **Step 6: Reset link**

Send a reset link → confirm the alert "Reset link sent to X. It expires after an hour — request another if it lapses."

- [ ] **Step 7: Admins — create**

Confirm the empty state and card description. `Add admin` → name, email, password → create.

Expected: the account appears Active; sign in with it and confirm the admin nav (no Reports, no Settings).

- [ ] **Step 8: Admins — deactivate / reactivate**

Deactivate → the badge flips to "Deactivated"; the admin's session is refused on the next click and sign-in shows "This account has been disabled." Reactivate → access returns.

- [ ] **Step 9: Admins — edit credentials**

Edit name only → saves. Edit password → the old one ❌ fails, the new one works. Submit the dialog with nothing changed → ❌ "Nothing to change".

- [ ] **Step 10: Admins — delete rules**

Delete the freshly created admin (no history) → succeeds. Attempt to delete an admin **with** recorded history → ❌ refused with "…deactivate instead".

- [ ] **Step 11: Alerts dials**

Change each of `warranty_expiry_alert_days`, `supplier_limit_warn_pct`, `quote_stale_days`, and the two suki rates. Enter an out-of-range value in each → ❌ four distinct toasts. Set the suki engine rate to a new value → confirm Record Sale's card price reflects it (Task 18 Step 3). **Restore the originals.**

- [ ] **Step 12: Notifications**

Confirm channel rows, the sublines ("Every alert lands in the bell in the top bar." / "Not built. Needs an SMS provider wired…"), and the "N pending dispatch(es) waiting to send." line. Confirm it is read-only.

- [ ] **Step 13: System**

Confirm both pg_cron jobs are listed with their purpose sentences and no secrets are shown. If any job is stale, confirm the alert title pluralises correctly.

- [ ] **Step 14: Settings read-failure behaviour**

(Optional, if reproducible) With the settings row unreadable, confirm Business and Alerts render **nothing** while Account/Admins/System still render.

- [ ] **Step 15: Log findings and commit**

---

### Task 17: Dashboard and Reports — both role variants

**Surface:** `app/(owner)/dashboard/page.tsx` · `app/(owner)/reports/**`

**Preconditions:** Task 14 Step 7 (a staff birthday today).

- [ ] **Step 1: Gerry's dashboard**

Confirm the four KPI cards, Top-selling products (hero tile + ranked list), the **Profit & Loss** card with net income, revenue, COGS, gross profit, expenses, shrinkage, and the three ops cards. Confirm the payables sub-line reads "₱X overdue (N)" or **"nothing overdue"**, and receivables "N unpaid sale(s) (utang)" or **"all collected"**.

- [ ] **Step 2: Birthday card**

Confirm the celebrant card appears (eyebrow "Birthday today 🎉", the tagline, avatar/initials) for the staff member created in Task 14.

- [ ] **Step 3: Admin's dashboard is money-free**

As ADMIN, confirm **zero peso signs** anywhere on the page: the sales KPI is a **count**, the P&L card is replaced by the **Working queue** card (three tiles: warranty claims / stock requests / return requests, each deep-linking correctly), and both Owed cards show **counts**. Confirm the "all caught up" variant renders when a queue is empty.

- [ ] **Step 4: Reports — Sales & Inventory (GERRY)**

Set a date range covering the seeded data. Confirm the sales/loss/top-parts charts, the engines-sold table, and each empty state ("No approved losses in this range." / "No approved part sales in this range." / "None in this range." / "Nothing is low right now."). Export CSV → downloads.

- [ ] **Step 5: Reports — P&L**

Confirm the statement, the headline delta "vs {prev range}", that **"Net income by month" renders only when the range spans >1 month**, that "Expense composition" renders only with approved expenses, and the truncation note when >12 months. Verify net income = gross profit − shrinkage − opex − overhead by hand against the displayed rows.

- [ ] **Step 6: Reports — Per-shop profitability**

Confirm each shop's Net Contribution, that **closed shops still appear** when they have activity in range (badged "Closed", and suffixed "(closed)" in the filter), and the expenses-by-shop matrix with its empty state and "—" zero cells.

- [ ] **Step 7: The two P&L views agree**

Confirm the Dashboard P&L card and `/reports?tab=pnl` show the **same** net income for the same period. A mismatch is an S1.

- [ ] **Step 8: Print the report**

Print → note whether the print header reads a hardcoded "Gerwin Trading" rather than the Settings business name (a known inconsistency — log it as S3 if the Settings name differs).

- [ ] **Step 9: Log findings and commit**

---

### Task 18: The Shop app end to end

**Surface:** `app/(shop)/shop/**` — 10 pages

**Preconditions:** stock delivered to Shop 1 (Task 6).

- [ ] **Step 1: My Shop Stock**

Confirm parts and engines in both table and card views, the `Out of stock` (grayscale) and `Low` badges, the "N of M items" and "N engine(s) on hand" counters, the **cost** shown beneath the selling price (the tawad floor), and both empty states. Note the engines card grid has **no search box** — confirm that is the intended design or log it.

- [ ] **Step 2: Edit own product photo**

Open a product's photo dialog → upload → toast "Photo saved for <name>". Remove → "Photo removed". Confirm the dialog cannot be dismissed while saving.

- [ ] **Step 3: Record Sale — cash, with tawad**

Scan/tap items into the cart. Confirm the cart header "Sale (N lines)", the description "Saved as your current report.", the sticky panel, and the empty placeholder "Scan or tap items on the left to add them."

Set a line price **below cost** → ❌ server rejects. Set it to cost + ₱1 → accepted. Add more than on-hand → ❌ toast "Only N <unit> of <name> on hand". Choose payment method **Cash** → the change helper appears; switch to **GCash** → it disappears. Save with "Print receipt on save" ticked → toast "Sale saved — printing receipt…" and the 58 mm receipt prints in place.

- [ ] **Step 4: Record Sale — suki card**

Enter the suki card number → `Apply` (confirm the spinner and that the button is disabled when empty). Bad number → ❌ "No active suki card with that number".

Expected: prices drop to the card price, the customer auto-fills **and locks**, toast "Suki: <name> — X% off engines, Y% off parts". Try to charge **above** the card price → clamped. Add another item **after** applying → it also comes in at the card price. Click `Clear` → prices revert **and the customer name/phone blank out**.

- [ ] **Step 5: Record Sale — utang (partial payment)**

Set payment type **Partial** with no customer → ❌ refused (a customer is required). Add a customer, enter a downpayment → save. Confirm the receipt prints "Downpayment via <method>" and the balance.

- [ ] **Step 6: Record Sale — engine**

Sell an engine → confirm the `Engine` badge, that the serial cannot be sold twice ("That engine is already in the sale"), and post-save that the scan input is **re-focused** and every field resets.

- [ ] **Step 7: Record Loss**

Confirm the header "What was lost?" and its description. Submit with no item → ❌ "Pick an item". Qty 0 → ❌ "Quantity must be positive". Qty above on-hand → ❌ "Only N <unit> on hand". Valid → saved as `recorded`; confirm the **reason selection is retained** after save.

- [ ] **Step 8: Shop expenses**

Confirm the default range is **month-to-date** and the Clear button appears only when a date is set. Record an expense with a receipt photo and a **proposed new category** (confirm the hint about Admin approving it). Blank amount → ❌ "Enter a valid ₱ amount". Save → toast "Expense recorded — it goes to Admin with your next report". Confirm company-wide expenses are **invisible** here.

- [ ] **Step 9: Low Stock and requests**

Confirm the request card renders **even when nothing is low**. Tick low items (quantities pre-filled to cover the shortfall), add a **custom new-product** row (placeholder "Product name (e.g. Yamaha 40HP water pump kit)"), submit with a blank qty → ❌ "Every requested item needs a quantity". Submit valid → toast "Request sent to Admin". Confirm **only the note and custom rows clear** afterwards.

- [ ] **Step 10: Submissions**

Confirm the "Current report" card with its computed description ("N sale(s) · M loss(es) · K expense(s) · ₱X sold · ₱Y spent…"), the section headers (SALES / LOSSES / EXPENSES) when mixed, and the empty states. Reprint a receipt from a row. Confirm the engine-sale row shows the **physical warranty card reminder** (pluralised for multiple engines) and ❌ **no** print-warranty button.

- [ ] **Step 11: Submit the batch**

`Submit to Admin` → toast `Sent to Admin: N sale(s), M loss(es), K expense(s)`; everything flips to `pending`; the Approval Queue badge increments in the ADMIN window (Task 8).

- [ ] **Step 12: Cancel before submit**

Record a new sale, then cancel it from Submissions → toast "Sale cancelled"; confirm its receipt route now **404s**.

- [ ] **Step 13: Log findings and commit**

---

### Task 19: Printable documents

**Surface:** `/receipt/[saleId]` · `/deliveries/[id]/note` · `/shop/deliveries/[id]/note` · `/transfer/[id]/slip` · `/return/[id]/slip` · `/counts/[id]/sheet` · `/stock-alerts/purchase-list` · `/movements/stock-card/print` · `/stock-alerts/request/[id]/receipt` · `/suppliers/receiving/[id]/print`

**Preconditions:** documents generated by Tasks 4–18.

- [ ] **Step 1: Sale receipt (58 mm)**

Print-preview a receipt. Confirm: single-column **58 mm** layout, the branch **logo** (from Task 14) above the letterhead — or the anchor when none, the business letterhead, the `Branch: <shop>` + location line, per-line prices, "Paid via <method>" (or "Downpayment via <method>"), the suki discount line where applicable, and the receipt footer from Settings.

- [ ] **Step 2: Thermal CSS is route-scoped**

Confirm the 58 mm sizing applies **only** here — print-preview the delivery note and count sheet and verify they are full-page, not narrow. (Automated: `npm test -- --with-http` asserts the `58mm` marker exists only on this route.)

- [ ] **Step 3: Owner delivery note**

Per-line cost + selling, totals at cost and at selling, prepared-by, shop location, and the Qty column reflecting sent vs received per Task 6 Step 8.

- [ ] **Step 4: Shop delivery note**

`/shop/deliveries/[id]/note` — confirm the `DN-XXXXXXXX` document number, the source line, the "Received"/"In transit" status, the note block, engine SNs, and that it also shows cost + selling (0064).

- [ ] **Step 5: Transfer slip**

From → To with locations, lines with **unit labels**, engine SNs, letterhead printing as an **outline** anchor (not a filled blue box), received qty + shortfall after confirmation, and a **blank** Approved column when not yet approved.

- [ ] **Step 6: Return slip**

Returned-by → Admin/Master, lines split **Good / Damaged**, engine SNs, reason, status, the Admin note when rejected, signature lines, and ❌ **no cost columns**.

- [ ] **Step 7: Party scoping (❌)**

Open the transfer slip as a **non-party** shop → ❌ 404. Same for the return slip. Open the receipt as a different shop → ❌ 404.

- [ ] **Step 8: Count sheet, purchase list, stock card, request receipt, receiving voucher**

Print each and confirm the letterhead, the signature/sign-off blocks, and the specifics already checked in Tasks 7, 12, 13, and 4.

- [ ] **Step 9: Log findings and commit**

---

### Task 20: Mobile sweep at 390 px

**Surface:** every overlay in the app

**Preconditions:** Tasks 1–19 (so real data exists behind each screen).

- [ ] **Step 1: Set the viewport**

DevTools → iPhone 14 Pro Max (430×932) **and** iPhone SE (375×667). Check both widths for each step below.

- [ ] **Step 2: No horizontal scroll anywhere**

Visit every top-level page in each role and confirm the page body never scrolls horizontally. Wide tables must scroll **inside** their own container.

- [ ] **Step 3: Overlays that were never mobile-tested**

Open and interact with each at 390 px — the content must be reachable, the primary button visible without zooming, and dismissal must work:

| Overlay | Route |
|---|---|
| Receiving: New product / New model / Bulk products | `/suppliers?tab=receiving` |
| Receiving detail | `/suppliers?tab=receiving&view=<id>` |
| Product edit + photo upload | `/master-inventory` |
| Merge duplicates | `/master-inventory` |
| Suppliers & prices | `/master-inventory` |
| Resolve discrepancy | `/deliveries` |
| Approve/Question/Reject | `/approvals` |
| Reviewed detail slide-over | `/approvals?tab=reviewed` |
| Record payment | `/receivables`, `/shop/receivables` |
| Card no. dialog | `/warranties`, `/shop/warranties` |
| Claim dialog | `/shop/warranties` |
| Shop edit + logo + colour picker + map | `/shops` |
| Staff dialog + photo | `/shops` |
| Credentials dialog | `/shops` |
| Expense dialog + receipt | `/expenses`, `/shop/expenses` |
| Admin account dialogs | `/settings?tab=admins` |
| Record Sale cart + suki | `/shop/record-sale` |

- [ ] **Step 4: Inputs do not trigger iOS zoom**

Confirm text inputs render at 16 px on mobile (`text-base md:text-sm`) — focus a field and verify the page does not zoom.

- [ ] **Step 5: Touch targets**

Confirm icon-only buttons (row kebabs, void, pencil, remove) are comfortably tappable and not crowded (≈44 px).

- [ ] **Step 6: Map picker on touch**

In the shop dialog, place and move the pin by touch.

- [ ] **Step 7: Log findings and commit**

---

### Task 21: The full role matrix — every lock, from both sides

**Surface:** all six locks

**Preconditions:** all prior tasks.

- [ ] **Step 1: Build the matrix**

For each row, verify **as ADMIN it is refused (❌)** and **as GERRY it succeeds**:

| # | Capability | Admin | Gerry |
|---|---|---|---|
| 1 | Edit product cost / selling price after entry | ❌ inputs disabled | ✅ |
| 2 | Edit engine selling price after entry | ❌ | ✅ |
| 3 | Remove product / remove in-master engine | ❌ hidden | ✅ |
| 4 | Retire engine model / retire category | ❌ hidden | ✅ |
| 5 | Merge duplicate products | ❌ hidden | ✅ |
| 6 | Void an utang payment | ❌ hidden | ✅ |
| 7 | Void an expense | ❌ hidden | ✅ |
| 8 | Create / change a shop login | ❌ hidden | ✅ |
| 9 | Close or reopen a shop | ❌ hidden + DB refuses | ✅ |
| 10 | Manage admin accounts | ❌ page hidden | ✅ |
| 11 | Write settings | ❌ page hidden | ✅ |
| 12 | See Reports / Expense Reports | ❌ redirected | ✅ |

- [ ] **Step 2: Confirm the admin's daily powers are intact**

As ADMIN, confirm these all still work: receive stock, deliver, approve batches, record + pay supplier debt, record + edit expenses, edit shop details/staff/colour/logo, manage catalog names/photos/fitment/barcodes, record suki cards, approve warranty claims, run counts.

- [ ] **Step 3: Shop isolation**

As SHOP, confirm: another shop's stock, warranties, receivables, and expenses are all invisible; the company-wide expenses never appear; and a non-party transfer/return slip 404s.

- [ ] **Step 4: Log findings and commit**

---

### Task 22: Fix, regress, and close out

**Preconditions:** Tasks 1–21 complete; `2026-08-01-qa-bugs.md` populated.

- [ ] **Step 1: Triage the bug log**

Group by severity. Confirm every S1 was already fixed mid-sweep. List the S2s and S3s in fix order.

- [ ] **Step 2: Fix remaining S2s**

For each, write the fix, then re-run the exact QA step that found it and tick it. Schema fixes become a new migration pushed to staging first.

- [ ] **Step 3: Fix the S3 batch**

Copy, spacing, and missing empty states — batch them into one commit per area.

- [ ] **Step 4: Full automated regression**

```bash
npx tsc --noEmit
npx next build
npm test
npm test -- --with-http     # dev server running: adds reports, settings-documents, ia-redirects, smoke-routes
```

Expected: typecheck clean, build clean, **all suites pass, 0 failed**. Re-run any suite that crashes with `Connect Timeout` — that is the network, not the code.

- [ ] **Step 5: Confirm the ledger still reconciles**

```bash
npm test -- --only=movements
```

Expected: `Σ movements = stock_levels` across every live product × location. Any drift after a QA sweep is an S1.

- [ ] **Step 6: Update the bug log with outcomes**

Mark every row `fixed`, `wontfix (reason)`, or `deferred (ticket)`. Nothing stays `open`.

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "qa: full sweep complete — N bugs found, M fixed"
```

- [ ] **Step 8: Green light for production**

Only when Steps 4–6 are clean, proceed to `docs/DEPLOYMENT.md` to create the production Supabase project.

---

## Coverage notes

Derived from a full read of `app/**` and `components/**` (10 agents, 2 passes each). Surfaces deliberately **not** covered, and why:

- **`components/ui/**` primitives** — exercised transitively through every dialog and table above.
- **Dead code** — `components/ui/tooltip.tsx`, `components/ui/field.tsx`, and `resetEmployeePassword` in `shops/actions.ts` have zero importers/callers. Flagged for deletion rather than QA; log as S3.
- **`/delivery-requests`, `/master-inventory/bulk-add`, `/shops/reports`, `/suppliers/payables`, `/master-inventory/receiving`** — redirect stubs; covered by `test-ia-redirects` in Task 22 Step 4.
- **SMS notification channel** — seeded disabled and not built.
