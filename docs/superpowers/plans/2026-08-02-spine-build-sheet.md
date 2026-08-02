# BUILD SHEET — Tasks 8 · 9 · 10

Harness: `scripts/qa-browser/qa-lib.mjs` (`session(browser, role, {clearLocalStorage, stubPrint})` → always `timezoneId: "Asia/Manila"`; `dbAuth(role)` = read-only PostgREST; `toast(page,{not})`; `clearToasts`; `check/step/summary`). Roles: `owner` (Gerry), `admin`, `shop` (Gerwin-Ternate), `shop2` (Gerwin-Naic).

Two helpers you will need on every one of these surfaces:

```js
// row addressing — walk DOWN, never nth() (README: an nth() mis-address
// resolved a real shop's discrepancy)
const row = (page, marker, btn) => page.locator('tr[data-slot="table-row"]')
  .filter({ hasText: marker });          // tables (warranties, serials)
const card = (page, marker) => page.locator('[data-slot="card"]')
  .filter({ hasText: marker });          // approvals, receivables, claims

// the window NEVER scrolls (shell root h-svh overflow-hidden)
const reveal = async (page, re) => {     // IntersectionObserver, rootMargin 600px
  const s = page.getByText(re);
  while (await s.count()) { await s.first().scrollIntoViewIfNeeded(); await page.waitForTimeout(400); }
};
```

---

## A) SELECTOR MAP

### TASK 8 — /approvals

Anchors used throughout:
- page: `page.getByRole('heading',{level:1,name:'Approval Queue',exact:true})` (the sidebar link has the same name — role+level is mandatory)
- tabs: `page.locator('nav[aria-label="Approval queue"]')` — **lowercase q**. Address tabs by **href**, never name: `a[href="/approvals?tab=all|sales|losses|expenses"]`; active = `a[aria-current="page"]`; badge = `… a[href=…] [data-slot="badge"]` (null at 0, and absent on first paint).
- cards: `page.locator('[data-slot="card"]').filter({hasText:'<ZZ-QA marker>'})`
- dialogs: `page.locator('[data-slot="dialog-content"]')`
- toasts: `page.locator('[data-sonner-toast]')` (never remove nodes)
- sentinel: `page.getByText(/^Loading more… \(\d+ of \d+\)$/)` — U+2026; `APPROVAL_PAGE = 5` (BATCHES on All, ITEMS on type tabs)

**Step 1 — tabs + empty states.** Assert the four hrefs exist and `aria-current` follows navigation. Empty copy (only observable when the queue is globally empty — see D):
- `Nothing waiting — you're all caught up.` (EM DASH U+2014, apostrophe is ASCII U+0027)
- `No sales awaiting approval.` / `No losses awaiting approval.` / `No expenses awaiting approval.`
- container: `page.locator('div.border-dashed')`

**Step 2 — batch anatomy.** Batch section: **NO STABLE HANDLE** — `<section class="overflow-hidden rounded-lg border">`, no id/data-*/aria. Fallback: `page.locator('section.rounded-lg.border').filter({hasText:'<shop name>'})` (ReviewedHistory's sections are `section.flex.flex-col.gap-3`, so `.rounded-lg.border` disambiguates). If two batches share a shop, filter by your fixture description instead.
- header bar: `batch.locator('div.border-b.bg-muted\\/50')`; counts caption `batch.locator('p.text-sm.text-muted-foreground').first()`
- caption fragments (assert **separately** — textContent glues shop name to caption): `submitted Aug 2, 3:45 PM · <employee>` · `earlier individual submissions` · `2 sales · 1 loss · 3 expenses · ₱4,250.00` · ` · 1 questioned (excluded from approve-all)` (MIDDOT U+00B7; ASCII hyphen in "approve-all"; the sales segment renders **even at 0**; the money segment is omitted when salesTotal is 0)
- group captions (literal uppercase in source): `SALES` · `LOSSES / ADJUSTMENTS` · `EXPENSES`
- badges: `card.locator('[data-slot="badge"]').filter({hasText:'Engine sale'})` · `…filter({hasText:/^Engine$/})` (anchor the regex) · `…filter({hasText:/^Questioned$/})` **scoped to the card** (ReviewedHistory has an identical badge lower on the same page) · suki `…filter({hasText:/^Suki /})` → `Suki <card_no> · −₱500.00` (U+2212 MINUS, not hyphen; the `· −₱X` half only when `card_discount_centavos > 0`)
- line row: `{description} × {qty}` (U+00D7); engine description `{brand} {model} — SN {serial}` (U+2014)
- negotiation strip: **NO STABLE HANDLE** — `card.locator('div.text-xs.text-muted-foreground').filter({hasText:'Floor'})`; the four values are separate spans that concatenate with no separator. Assert per-span: `getByText('Asking ₱120,000.00')`, `getByText('Floor ₱95,000.00')`, `getByText('₱5,000.00 off')`. `at floor` — see B8.2.
- payment line: `Partial · paid ₱500.00 · balance ₱1,000.00` / `Paid in full`; method labels `Cash|GCash|Bank|Other`
- receipt link: `card.getByRole('link',{name:/^Receipt/})` — `target=_blank`, use `ctx.waitForEvent('page')`

**Step 3 — approve one sale.** `card.getByRole('button',{name:'Approve',exact:true})` — `exact:true` **mandatory** (four buttons named "Approve" on the page; `Approve all (N)` is a superstring). Toast: `Sale approved — stock deducted`.

**Step 4 — question a loss.** `card.getByRole('button',{name:'Question',exact:true})` → heading `Question this line`; textarea `page.getByPlaceholder('e.g. Bakit 3 pcs? Isa lang nabenta kanina…')` (U+2026; no id, no aria-label — placeholder is the only handle; fallback `[data-slot="dialog-content"] textarea`); confirm `page.locator('[data-slot="dialog-content"]').getByRole('button',{name:'Send question',exact:true})`.
- blank note → **client** toast `Write the question for the employee` (the server's "A question needs a note for the employee" is unreachable)
- success toast `Question sent`; the card **stays** in the queue with the `Questioned` badge + `Your note: <text>`
- SHOP side (`/shop/submissions`, Submitted tab): badge `Questioned`, note prefix is **`Owner: <note>`** (not "Your note:") — `app/(shop)/shop/submissions/submissions-view.tsx:260`

**Step 5 — reject.** `card.getByRole('button',{name:'Reject',exact:true})` → heading `Reject this line`; textarea `page.getByPlaceholder('Reason (optional)')`; confirm **must** be scoped: `page.locator('[data-slot="dialog-content"]').getByRole('button',{name:'Reject',exact:true})`. Empty note is legal → toast `Rejected`; card leaves the queue.

**Step 6 — approve-all.** `batch.getByRole('button',{name:/^Approve all \(\d+\)$/})`. Toast: `Batch approved — 2 sale(s), 1 loss(es) and 0 expense(s)` — the `(s)/(es)` are **literal**, never pluralised. Questioned excluded (N counts pending only). Legacy group: assert `count() === 0`, **not** `toBeDisabled()`.

**Step 7 — approve an expense.** The card's Approve **opens a dialog**, it does not call the RPC: `page.getByRole('dialog',{name:'Approve this expense?'})`.
- active category line (innerText): `Category: Gasolina — counts in expenses and P&L once approved.`
- proposed: badge on card `proposed: ZZ-QA Boat Repair`; Select `page.getByRole('dialog',{name:'Approve this expense?'}).getByRole('combobox')` — **no accessible name**, `getByLabel('Category')` fails; fallback `[data-slot="dialog-content"] [data-slot="select-trigger"]`. Options are portalled → query from `page`: `getByRole('option',{name:'Keep as proposed — creates “ZZ-QA Boat Repair”'})` (U+2014 + U+201C/U+201D) or an existing category name. Radix needs a **real click**.
- confirm: `dialog.getByRole('button',{name:'Approve',exact:true})`; toast `Expense approved` for both paths.

**Step 8 — engine sale.** Same Approve as Step 3; there is no UI signal beyond the toast — everything else is DB (section C).

**Step 9 — realtime.** SHOP context submits: `page.getByRole('button',{name:/^Submit \d+ to Admin$/})` → shop toast `Sent to Admin: 1 sale(s), 0 loss(es), 0 expense(s)`. Owner page (no reload): new batch section appears; toast `New submission arrived` (fires on any UPDATE landing on `status='pending'`, 400 ms debounce, **all shops**).

**Step 10 — Reviewed History.** Section: `page.locator('section').filter({has: page.getByRole('heading',{name:'Reviewed History'})})`. Table: `page.locator('table')` (unique — the queue renders no `<table>`).
- **Drive filters by URL, not the widgets**: `?shop=<uuid>&type=sale|loss|utang_payment|expense&status=approved|rejected|questioned&from=YYYY-MM-DD&to=YYYY-MM-DD&q=…&page=N`. The three Selects have **NO stable handle** (`[data-slot="select-trigger"].w-44|.w-40|.w-36`), and **both** DatePickers expose the identical name `Pick a date`.
- search box is the one good handle: `page.getByLabel('Search reviewed history')`, placeholder `Customer, serial, product, receipt…`; **applies only on `.press('Enter')`** (no button, no debounce).
- counter: `page.getByText(/\d+–\d+ of \d+/)` — **EN DASH U+2013**, total is `toLocaleString()`; zero case is `0 items`. Page indicator `page.getByText(/^Page \d+ of \d+$/)`.
- empties: `Nothing matches those filters.` (activeFilters > 0) vs `Nothing reviewed yet.`
- rows: `page.locator('table tbody tr[role="button"]')`; aria-labels `Open Sale detail` / `Open Loss detail` / `Open Payment detail` / `Open Expense detail` (**Payment**, not "Utang payment")
- page-reset assertion: after any filter click, `new URL(page.url()).searchParams.has('page') === false`
- pager: `getByRole('button',{name:'Previous'|'Next'})` — `disabled:pointer-events-none`, so assert `toBeDisabled()`, never click.

**Step 11 — detail sheet.** `page.locator('[data-slot="sheet-content"]')`. Header `[data-slot="sheet-title"]` (type badge + status badge), sub-header `[data-slot="sheet-description"]` (`<shop> · Aug 2, 2026 3:04 PM`).
- section by heading: `sheet.locator('section').filter({has: page.getByRole('heading',{name:/^resulting stock movements$/i})})` — **case-insensitive regex required**, headings are CSS `uppercase` so `innerText` returns CAPS.
- movements empty: `No stock moved (nothing was approved).`
- field value: `sheet.getByText('Receipt no',{exact:true}).locator('xpath=following-sibling::div')`
- cost line: `sheet.getByText('Owner-only:',{exact:true})` → read the **parent** div (`Owner-only: cost ₱X · margin ₱Y`)
- expense receipt img: `sheet.getByRole('img',{name:'Receipt'})` (signed URL; on failure an unlabelled icon renders — assert the `Receipt` heading present + img absent)
- payment: scope the `Payment` section then `getByText('Before',{exact:true})` / `getByText('After',{exact:true})` + following-sibling div; `sheet.getByText('Settled',{exact:true})`
- loading: **NO STABLE HANDLE** — raw `<Loader2 class="size-4 animate-spin">`, no role. Use `getByText('Loading detail…')` and throttle the server-action POST to see it:
  ```js
  await page.route(u => new URL(u).pathname === '/approvals', async r => {
    if (r.request().method() === 'POST') await new Promise(s => setTimeout(s, 1500));
    await r.continue();
  });
  ```
- reload persistence: assert `new URL(page.url()).searchParams.get('item')` **decoded** — a row click percent-encodes the colon (`sale%3A…`), the payment sheet's `Open sale` link writes a raw colon.

**Step 12 — bad deep link.** Panel: `sheet.locator('p.text-destructive')` (no role, no `[role=alert]`). See B8.15/B8.16 for what to actually assert.

---

### TASK 9 — /receivables + /shop/receivables

**Step 1 — owner list.** H1 `getByRole('heading',{name:'Receivables',level:1})`; tabs `nav[aria-label="Receivables"] a[href="/receivables?tab=open"|"?tab=paid"]`, active via `aria-current="page"`, badges `… [data-slot="badge"]` (null at 0, second streaming pass).
- summary cards: `page.locator('[data-slot="card"]').filter({hasText:'Total outstanding'|'Shops owing'|'Customers owing'})`; captions `across 3 open sales` / `Gerwin Ternate highest` / `Juan Dela Cruz owes ₱2,500.00` / `none`
- empties: `No outstanding balances.` (open) / `Nothing fully paid yet.` (paid)
- `N voided`: `page.locator('span.text-warning-foreground').filter({hasText:/^\d+ voided$/})` — **per receivable card**, not the summary strip

**Step 2 — badges.** `Settled` (balance ≤ 0, in `[data-slot="card-title"]`); `Sale pending|Sale recorded|Sale questioned` (raw lowercase enum, and **suppressed** once settled). Shop side uses different copy: `Sale not yet approved`.

**Step 3 — shop records a payment.** Card button `card.getByRole('button',{name:'Record payment',exact:true})` (three identical strings on screen once open: card trigger, dialog title, footer submit — always scope).
- amount `#pay-amount`; `Full balance (₱1,500.00)` shortcut; payer `#pay-payer`; contact `page.getByLabel('Payer contact number')`; methods `dialog.getByRole('button',{name:'GCash',exact:true})` — **`exact:true` required**, `Cash` is a substring of `GCash`; selection state is `data-variant="default"` vs `"outline"` (no aria-pressed)
- submit `page.locator('[data-slot="dialog-footer"]').getByRole('button',{name:'Record payment',exact:true})`
- **over-balance signal is inline, not a toast**: `dialog.locator('p.text-destructive')` → `More than the ₱1,500.00 owed`
- blank payer signal: `#pay-payer` gains class `border-destructive` (no text)
- success: `Fully paid — utang settled` (amount === balance) or `Payment recorded — balance now ₱1,000.00`
- "does not enter the queue": assert `/shop/submissions` Current/Submitted counts unchanged + owner `/approvals` has no new item

**Step 4 — shop has no void.** `expect(page.getByRole('button',{name:/void/i})).toHaveCount(0)`; then expand `card.getByRole('button',{name:/^History \(\d+\)$/})` and assert `Recorded a payment by mistake? Call the owner — only he can void it (the balance is restored and the entry stays in this history).`

**Step 5 — admin has no void.** `getByRole('button',{name:/^Payment history \(\d+\)$/})` then `expect(page.locator('[aria-label="Void payment"]')).toHaveCount(0)` — **absent, not disabled**.

**Step 6 — Gerry voids.** `page.locator('[aria-label="Void payment"]')` (icon-only, one per live row) → `page.getByRole('alertdialog')` (AlertDialog, **not** `dialog`), title `Void this payment?`, body `₱1,500.00 goes back onto Juan Dela Cruz's balance. The entry stays in the history, struck through.` (ASCII apostrophe) → `getByRole('button',{name:'Yes, void it'})`. Toast `Payment voided — balance restored`. After refresh: `[data-slot="badge"]` `Voided`, amount span `.line-through`, meta line appends ` · Voided by the owner`.

**Step 7 — CSV.** `getByRole('button',{name:'CSV'})` (disabled when the filtered set is empty) → `page.waitForEvent('download')`, filename `receivables.csv`. Strip the UTF-8 BOM; header order `date,receipt_no,shop,customer,phone,item,total,downpayment,paid_since,balance`; amounts are plain pesos, **no ₱**; null customer → literal `Walk-in`.

---

### TASK 10 — /warranties + /shop/warranties

**Always navigate with an explicit `?tab=`** — bare `/warranties` lands on **Approval** whenever any claim is `requested`.

**Step 1 — owner registry.** `?tab=warranty`. Tabs `getByRole('tab',{name:/^Approval/})` etc. (**regex** — TabCountBadge injects the count into the name). Headers: `Serial | Model | Customer | Sold by | Sold | Expires | Status | Card no.` (trailing period). Status badge `row.locator('[data-slot="badge"]')` → `Active` / `Expired`. Card no. cell = 8th `td` (index 7), mono span or `—` (U+2014). Empty state `No warranties yet — they appear automatically when you approve an engine sale.` (see B10.4). Search `input[placeholder="Search serial, customer, model…"]` (600 ms debounce, Enter fires immediately).

**Step 2 — no certificate.** Assert absence on three surfaces + `/warranties/<id>/certificate` → genuine **404** (`page.goto` status 404, not the Next-16 meta-refresh stub pattern). Also assert no `PrintButton`/`Print` control in the owner row actions, shop list, shop detail dialog, and the Submissions engine row — the Submissions row instead reads `Engine sale — hand the customer their physical warranty card…`.

**Step 3 — shop records a card no.** `?tab` n/a; row → `row.getByRole('button',{name:'Record card no.',exact:true})` (present **only** while `warranty_serial` is null). Dialog `page.locator('[data-slot="dialog-content"]').filter({hasText:'Warranty card number'})`; input `[data-slot="dialog-content"] input[placeholder="e.g. WC-000123"]` (**no id, no aria-label** — placeholder is the only handle); `.press('Enter')` submits (real `<form>` + `type=submit`). Toast `Card number recorded`. Assert the **rendered cell**, not `inputValue()` (B10.6).

**Step 4 — duplicate.** Type `wc-qa-001` on a second warranty → toast contains `Card number WC-QA-001 is already recorded on another warranty` (message carries the **cleaned, uppercased** value). Match `/already recorded/i`.

**Step 5 — searchable.** Shop: `page.getByLabel('Look up a warranty by serial')` (client-side filter, includes `warranty_serial` — verified `app/(shop)/shop/warranties/warranties-view.tsx:164`). Owner: registry search box (server-side, `warranty_registry.search_text` includes it since 0103).

**Step 6 — cross-shop isolation.** `session(browser,'shop2')` → lookup the serial → assert row count 0 (**not** body text — the empty state quotes your term back) + banner `This engine wasn't sold by this shop.` / `Please contact Admin — they can look it up across all branches.` (requires `q.length >= 4`).

**Step 7 — owner edits/clears.** Pencil `row.getByLabel('Edit warranty card number')` — **owner label**; the shop's is `Edit card number`. Clear → toast `Card number cleared`, cell renders `—`.

**Step 8 — repair claim.** Shop: row `View` → detail dialog → `dialog.getByRole('button',{name:'File a claim',exact:true})` (**`exact:true`** — `File claim` is the submit). Issue `#claim-issue` (placeholder `e.g. hard to start, smoking, gearbox noise`); resolution toggles `dialog.getByRole('button',{name:'Repair'|'Replace'|'Refund',exact:true})` (selected = `data-variant="default"`, no aria-pressed); submit `dialog.getByRole('button',{name:'File claim',exact:true})`. Blank issue → toast `Describe the issue`. Success `Claim filed — waiting for Admin to approve`. Claims tab `[data-slot="tabs-trigger"][value="claims"]`; card **NO STABLE HANDLE** — `page.locator('[data-slot="tabs-content"] div.rounded-lg.border').filter({hasText:'SN <serial>'})`; badge `Waiting for Admin`; `Cancel` renders only while `requested` and fires the RPC with **no confirmation**.

**Step 9 — admin approves.** `/warranties?tab=approval`; claim card `page.locator('[data-slot="card"]').filter({hasText:'SN <serial>'})` → `Approve` → toast `Claim approved`.

**Step 10 — replace.** Picker `[data-slot="dialog-content"] button[role="combobox"]` (**must** be scoped — unscoped it hits the DataTable's Rows-per-page select behind the overlay); options `{brand} {model} · SN {serial}`. Blank → toast `Pick a replacement engine`. **Precondition: the shop must hold ≥1 other `delivered` engine**, otherwise File claim is permanently disabled and the toast can never fire.

**Step 11 — refund.** `#claim-refund` (strips non `[0-9.]`, so a negative/₱ path is impossible). Blank → toast `Enter the refund amount`.

**Step 12 — reject.** Owner claim card → `Reject` → dialog `Decline this claim?`; textarea `textarea[placeholder="e.g. out of warranty, customer misuse"]`; confirm `Decline claim`. Blank note → **client** toast `Give a reason`. Success `Claim declined — the shop was told`.

**Step 13 — serials journey.** `?tab=serials`; search `input[placeholder="Scan or type any serial…"]`; `row.getByRole('button',{name:'Journey'})` (**identical on every row — scope by row**). Dialog `[data-slot="dialog-content"]` filtered by `Journey —`; spinner `dialog.locator('svg.animate-spin')` (**no role/aria**); nodes `dialog.locator('ol > li')`; labels `Received into master` / `Delivery — <shop>` / `Return` / `Sold` / `Written off`; timestamp `MMM d, yyyy h:mm a` + optional ` · <note>`; empty `No recorded movements for this serial.`. Green/red nodes are on a **different page** — see B10.1: `/movements?tab=engines&serial=<SN>` → `Warranty issued — 12 months`, `Expires Mar 30, 2027 — expired`, link `View in registry`, `Warranty claim — approved`.

---

## B) PLAN-vs-CODE MISMATCHES

### Task 8

1. **Step 2 "at floor"** — plan lists it as part of the strip to confirm. Code: rendered only when `agreed ≤ floor`, but `fn_record_sale` refuses any price at or below cost, so on a freshly recorded sale `agreed > floor` always. `approvals-view.tsx` + `0053`. **Plan wording is stale** — either build it deliberately (record, then raise `engines.cost_centavos` as Gerry) or skip.
2. **Step 2 "Questioned (card gets a warning border)"** — code sets `className="border-warning"`, which is border-*color* only; `Card` uses `ring-1 ring-foreground/10` and Tailwind v4 preflight zeroes border-width globally → computed `borderWidth: 0px`. Nothing is visible. **Possible real defect (cosmetic)**; same copy-paste in `transit-panel.tsx`, `payables-view.tsx`, `count-entry.tsx`. Assert the **badge**; log the border.
3. **Step 2 negotiation strip** — guard is `l.is_engine && l.floor_centavos != null`, so a discounted **part** line shows only its line total even though parts have been negotiable since 0053 and store `agreed/list/discount` identically. **Possible real defect (coverage gap)** — the owner cannot see a part tawad on the approval card.
4. **Step 3 "COGS is frozen (verify in the detail sheet, Step 8)"** — two errors. (a) The detail sheet is **Step 11**, not Step 8. (b) The sheet **cannot prove the freeze**: `history-actions.ts:217` reads `engines.cost_centavos ?? parts.cost_centavos` **live**; `sale_line_costs` is never queried. **Plan is wrong** — verify via DB (section C).
5. **Step 4 "Question requires a note"** — enforced **client-side only** (`onDialogSubmit` returns before the action). Assert `Write the question for the employee`; the DB string `A question needs a note for the employee` is unreachable from this UI. Plan doesn't name a string, so: **stale/incomplete**, not a defect.
6. **Step 6 "legacy-`<shop>` groups have no Approve-all"** — correct, but the button is **not rendered** (`{b.batchId && …}`); a `toBeDisabled()` wait times out at 30 s. Also such a group only exists for pre-0017 `batch_id IS NULL` rows — **may be unverifiable on the current dataset** (see D).
7. **Step 7 "Category: `<badge>` — counts in expenses and P&L once approved."** — source writes `P&amp;L`; DOM innerText is `P&L`. Matches. But note **Approve-all can never remap** (always `p_remap_category_id = NULL`), so every proposed category in a batch is activated — the remap path is per-card only. **Plan is fine; add the negative assertion.**
8. **Step 10 "Switch to Reviewed"** — **there is no Reviewed tab.** `resolveTab()` accepts only `all|sales|losses|expenses` and coerces anything else to `all`; Reviewed History renders below the queue on **all four** tabs. `approval-tabs.tsx:10-15`, `page.tsx`. **Plan wording is stale.** (The CLAUDE.md page-inventory line implying `?tab=reviewed` is stale too.)
9. **Step 10 "any filter change resets paging to page 1"** — true, and **also true for actions the plan does not mention**: clicking a row (`setParam({item:…})`) and closing the drawer (`setParam({item:null})`) both delete `page` (`reviewed-history.tsx:145`). Open a detail from page 3 → the list silently jumps to page 1. **Possible real defect worth investigating.**
10. **Step 10 "two distinct empty rows"** — `activeFilters` ignores `page`, so `?page=99` with no filters renders `Nothing reviewed yet.` even with hundreds of rows. Beyond-range paging is also ambiguous (200+empty → counter prints nonsense like `41–5 of 5`; 416 → `0 items`). **Possible real defect (minor).**
11. **Step 11 "owner-only per-line cost + margin"** — visible to an **ADMIN** too: `/approvals` is gated by `requireOwner()` = office tier, and `parts`/`engines` RLS is `is_owner()`. The label says "Owner-only". **Possible real defect worth investigating** against 0099's "admin dashboard is money-free" intent.
12. **Step 11 sections** — `Resulting stock movements` exists on **sale and loss bodies only**. Payment and expense bodies have none (the expense substitutes prose). A test expecting it on all four types fails on two. **Plan wording is stale.**
13. **Step 11 loading state** — the error state leaves `[data-slot="sheet-description"]` reading `Loading…` **forever** (`detail` stays null on every error path), so a "wait for Loading… to disappear" precondition hangs. Also a `Bad link` returns **before** `setDetail(null)`, leaving the previous item's whole body rendered under the red panel. **Possible real defect (minor UX/copy).**
14. **Step 12 "expect the red error panel reading `Not found`"** — **WRONG.** `00000000-0000-4000-8000-000000000000` passes zod v4's `z.uuid()`, reaches PostgREST, and `.single()` on 0 rows sets `error`, so `error?.message ?? "Not found"` prints the **PGRST116** message (`JSON object requested, multiple (or no) rows returned` / `Cannot coerce the result to a single JSON object`). The literal `Not found` is **dead code on all four branches** (`history-actions.ts:182/268/321/363`). **Plan wording is stale** — assert the panel exists + `/not found|rows|coerce/i`.
15. **Step 12 bonus — REAL DEFECT, highest value.** `?item=bogus:<uuid>` (and `?item=:<uuid>`, whose type is `""`, which the `?? "sale"` nullish guard does **not** catch) reaches `<TypeBadge type={itemType}/>` before any server call; `TYPE_META[type].icon` throws `TypeError`, caught by `app/error.tsx` — the **root** boundary — which replaces the entire owner shell with `Something went wrong`. The server's `Invalid item` guard can never render for a bad type. `reviewed-detail-sheet.tsx:118,128` + `reviewed-history.tsx:91-92`. Add this as an extra step.
16. **Not in the plan but worth asserting:** loss reason `warranty` (added 0069) has **no** `REASON_LABEL` entry → the badge renders **empty**. Latent; only reachable if a warranty loss is ever pending (owner-created ones are born approved). **Possible real defect (latent).**
17. **Not in the plan:** the expense card prints the **raw lowercase** `payment_method` (`gcash`) while the sale card maps through `METHOD_LABEL` (`GCash`) — same DB value, two renderings, same page. **Possible real defect (cosmetic inconsistency).**

### Task 9

18. **Step 3 — all three ❌ toasts are DEAD CODE.** `disabled={busy || tooMuch || amountC <= 0 || noPayer}` (`app/(shop)/shop/receivables/receivables-view.tsx:502`) guards exactly the three conditions `onSave()` re-checks, and there is **no `<form>`**, so Enter cannot submit either. `Enter the amount the customer paid`, `That's more than the ₱X balance`, and `Enter who paid` can **never** fire. **Plan wording is stale** — this step as written fails against correct code. Replace with: `expect(submit).toBeDisabled()`, the inline `More than the ₱1,500.00 owed`, and the `border-destructive` ring on `#pay-payer`.
19. **Step 1 "per-shop and per-customer totals"** — there is no breakdown. The three cards show a peso total + two **counts**, each with one caption naming the highest (`Gerwin Ternate highest`, `Juan Dela Cruz owes ₱2,500.00`). `app/(owner)/receivables/page.tsx:104-145`. **Plan wording is stale.**
20. **Step 1 "the 'N voided' counter in the totals strip"** — it is rendered **inside each receivable card's footline** (`receivables-view.tsx:303-305`), not in the summary strip, and only when that sale has ≥1 voided payment. **Plan wording is stale.**
21. **Owner page sub-heading is factually false** — `Every unpaid balance (utang) across all shops. Balances only drop when you approve a payment in the Approval Queue.` Utang payments have posted **immediately** since 0026 and never enter the queue — the plan's own Step 3 asserts the opposite. `app/(owner)/receivables/page.tsx:44-47`. **Real copy defect — report it.**
22. **Step 4 "the note 'Recorded a payment by mistake? Call the owner…'"** — the note lives **inside an expanded `History (N)` block**, so it requires ≥1 existing payment on that sale and a click. On a receivable with zero payments there is no History button and no note. **Plan wording is stale** (ordering dependency: run Step 3 first).
23. **Step 5 "no void icon"** — the control is **absent from the DOM**, not disabled and not toast-guarded (`canVoid = profile.role === 'owner'`). Assert `toHaveCount(0)`.
24. **Step 6 "the office receives an alert"** — the notification is `recipient_role='owner'`, which is **office tier** RLS, so the **admin's** bell lights up for an action he cannot perform. Correct behaviour by design, but assert it as "office bell", not "Gerry's bell".
25. **Step 6 dialog** — on **failure** `ConfirmDialog` closes anyway (it closes after `onConfirm` resolves regardless of `res.ok`) and only an error toast remains. Do not assert "dialog stays open".
26. **Authority proof is weak by construction** — `voidUtangPayment()`'s app guard returns the **same sentence** as the RPC (`Only the owner can void a payment`). Seeing that toast does not prove the DB refused. Probe `supabase.rpc('fn_void_utang_payment')` directly on an admin session — and use a **LIVE** payment id, because `Payment not found` is raised **before** the tier check.
27. **Step 7 CSV** — on the Fully paid tab a **negative** (overpaid) balance exports raw (`-50.00`) while the card clamps the display to `₱0.00` (`Math.max(0,…)`). **Possible real defect (minor).** Also the export covers all `filtered` rows, not just the 20 visible — do not compare against the rendered page without revealing everything first.

### Task 10

28. **Step 13 — the green warranty node and red claim nodes are NOT on this surface.** The Warranties → Serials **Journey** dialog renders `stock_movements` rows only. The green `Warranty issued — N months` node and the red `Warranty claim — <status>` nodes live in `app/(owner)/movements/engine-history-view.tsx:184-216`, i.e. `/movements?tab=engines&serial=<SN>`. **Plan wording is stale** — split Step 13 into two assertions against two URLs, or this step fails against correct code.
29. **Step 13 "received → delivered → sold"** — actual node labels are `Received into master`, `Delivery — <shop>`, `Sold`. There is no node reading "delivered". Also the journey **filters out** `qty_change < 0` non-sale/loss rows, so the master-side delivery debit is hidden and you see one landing node, never a send/receive pair. **Plan wording is stale.**
30. **Step 13 journey label gaps** — `MOVE_LABEL` has no `transit_return` (renders the raw token `transit_return`) and `transit_writeoff` is filtered out entirely. **Possible real defect (cosmetic).**
31. **Step 13 empty state** — `No recorded movements for this serial.` is near-unreachable: any engine that ever entered master has a `received` +1 row that passes the filter. Expect to skip or construct deliberately.
32. **Step 1 empty state** — unreachable with seeded data, and with a search active the empty cell shows `Nothing matches “<q>”.` **instead**. Assert row count, not body text.
33. **Step 2 — leftover dead file.** `components/warranty-certificate.tsx` still exists on disk (including a `<PrintButton label="Print certificate" />`) with **zero importers** — 0103 deleted the three routes but not the shared component. The routes do 404 as the plan expects, so this is not user-visible. **Possible real defect (dead code) — worth reporting for cleanup.**
34. **Step 3 "the value renders uppercase and mono"** — the input's `uppercase` is CSS `text-transform` only; `inputValue()` returns exactly what you typed. Only the DB uppercases (`upper(trim())`). Assert the **saved table cell**. **Plan wording is imprecise** (and it is the trap that makes the step fail).
35. **Step 3 "the dialog refuses to close while saving"** — true (`onOpenChange={(o)=>!o && !busy && onClose()}`, Cancel disabled) but `busy` lasts <500 ms; unobservable without throttling the server-action POST. **Plan is right, the step is impractical as written.**
36. **Step 7 pencil** — the owner label is `Edit warranty card number`; the **shop's** is `Edit card number`. Do not share a selector constant. Both are identical **on every row** — no per-row identity. **Missing stable handle, worth logging.**
37. **Step 9 "As ADMIN → Approve"** — works: `fn_approve_warranty_claim` guards on `is_owner()` = office tier since 0099, even though its refusal string still says "Only the owner can approve warranty claims". Do **not** write this as a Gerry-only power. **RPC copy is stale, behaviour is correct.**
38. **Step 10 "Blank replacement → ❌ 'Pick a replacement engine'"** — reachable **only if the shop holds ≥1 other on-hand engine**; with zero spares the File-claim button is `disabled` and the Select reads `No spare engines on hand`, so no toast can ever fire. Note the server's string is different and longer (`Pick a replacement engine from your stock`) and is unreachable. **Precondition gap in the plan.**
39. **Step 10 "the warranty repoints"** — `fn_approve_warranty_claim` does `update warranties set engine_id = <replacement>`, and `warranties.engine_id` is **UNIQUE** with no exception handler. If the replacement engine ever carried a warranty row, the approval fails with a raw Postgres `unique_violation`. **Possible real defect worth investigating.**
40. **Step 11 refund** — the expense is `scope='company'`, `source='owner'`, `status='approved'`, `shop_id NULL`. It is therefore **invisible** in the shop's expense list **and absent from Reviewed History** (`reviewed_items` filters `source='shop'`). Verify via DB, not via either list. **Plan is silent; add the caveat.**
41. **Steps 9/12 default tab** — bare `/warranties` lands on **Approval** iff any claim is `requested`, else **Warranty** (`page.tsx:106`). A concurrent agent filing/deciding a claim changes where you land. **Always pass `?tab=`.**
42. **Not in the plan — settings divergence.** The owner registry's near-expiry highlight is a **hardcoded** `daysLeft <= 30` (`warranties-view.tsx:257,430`), while the shop's `expiring_soon` comes from `fn_warranty_alert_days()` → `settings.warranty_expiry_alert_days`. Move the dial off 30 and the two surfaces disagree. **Possible real defect worth investigating**; never carry an "expiring soon" assertion across the two pages.

---

## C) WHAT TO VERIFY IN THE DATABASE

`const q = await dbAuth('admin')` (office tier — required for `sale_line_costs`, `stock_movements`, `warranty_claims`, `expenses`). Always append `&deleted_at=is.null` unless you are checking a soft-delete. Capture a **baseline read immediately before** each mutating click.

**T8 S3 — approve one sale (the full approval proof, 5 reads):**
1. `sales?id=eq.<id>&select=status,reviewed_by,reviewed_at,owner_note` → `status='approved'`, `reviewed_by` = the approver's uid, `reviewed_at` non-null. A prior question note **survives** (`owner_note = coalesce(p_note, owner_note)`, and the UI sends no note on approve).
2. `stock_levels?part_id=eq.<p>&shop_id=eq.<s>&select=qty` before/after → delta **exactly** `−line.qty`. (Engine lines never touch this table.)
3. `stock_movements?sale_id=eq.<id>&select=movement_type,qty_change,shop_id,part_id,engine_id,actor,note` → one row per line, `movement_type='sale'`, `qty_change = −qty` (parts) / `−1` (engines), `shop_id = sales.shop_id`, `note = sale_lines.description`. Append-only — assert **count**, and assert no row existed before.
4. **COGS freeze:** `sale_line_costs?sale_id=eq.<id>&select=sale_line_id,unit_cost_centavos,line_cost_centavos` → **one row per sale line**, `line_cost = unit_cost × qty`, `unit_cost` = `parts.cost_centavos` (or that serial's `engines.cost_centavos`) **as read at approval**; a null cost stores `0`, never null. This is the only proof of the freeze — the detail sheet cannot give it (B8.4). Bonus negative: the same query on a `shop` session returns **0 rows** (RLS), not an error.
5. `sales?id=eq.<id>&select=settled_at,amount_paid_centavos,balance_due_centavos` → **unchanged**; `fn_approve_sale` touches none of these.

**T8 S4 — question:** `losses?id=eq.<id>&select=status,owner_note,reviewed_by,reviewed_at` → `status='questioned'`, `owner_note` set, **`reviewed_by`/`reviewed_at` still NULL** (only a reject stamps them). No `stock_movements` row. Then approve → `losses.value_centavos` frozen = `parts.cost_centavos × qty` (whole line) or the engine's own cost; `stock_movements.movement_type='loss'`, `note = reason || ': ' || note`; an engine loss **soft-deletes** the engine (`engines.deleted_at` set) while `status` stays `'delivered'`.

**T8 S5 — reject:** `status='rejected'`, `owner_note` = note or NULL, `reviewed_by`/`reviewed_at` **stamped**. Assert `stock_movements?sale_id=eq.<id>` count is 0 and `stock_levels` unchanged.

**T8 S6 — approve-all:** all `sales/losses/expenses?batch_id=eq.<b>&status=eq.pending` → 0 remaining; questioned rows **still** `questioned`. Negative test: force one line short and assert **zero** rows flipped (one transaction, all-or-nothing) plus every card still on screen.

**T8 S7 — approve an expense:**
- as-proposed: `expenses?id=eq.<e>&select=status,approved_by,approved_at,category_id` → approved; **and** `expense_categories?id=eq.<c>&select=status` → flipped `proposed`→`active`.
- remap: `expenses.category_id` = the remap target **and** `expense_categories?id=eq.<c>&select=status` → **still `proposed`** (this is the whole point of the step).
- either way: no `stock_movements` row.

**T8 S8 — engine sale:**
- `engines?id=eq.<e>&select=status,customer_id,sold_at,shop_id` → `status='sold'`, `customer_id` = the sale's, `sold_at` set, **`shop_id` still the selling shop** (it is deliberately not cleared).
- `warranties?engine_id=eq.<e>&select=sale_id,customer_id,sold_on,months,expires_on,warranty_serial` → one row; `warranty_serial` **NULL** at this point.
- **term provenance (read, never hardcode):** `months = engines.warranty_months ?? engine_models.default_warranty_months ?? settings.default_warranty_months ?? 12`. Read the chain in the same instant: `engines?id=eq.<e>&select=warranty_months,engine_model_id`, `engine_models?id=eq.<m>&select=default_warranty_months`, `settings?id=eq.1&select=default_warranty_months`.
- `sold_on = ph_today() AT APPROVAL`, **not** `sales.business_date`; `expires_on = sold_on + months months`.
- `stock_movements` engine row: `qty_change=-1`.

**T9 S3 — record payment:** `utang_payments?sale_id=eq.<s>&order=created_at.desc&limit=1` → `status='approved'`, `reviewed_at` set, **`reviewed_by` NULL**, `method`, `payer_name`, `payer_contact` as entered. `sales?id=eq.<s>&select=settled_at` → set iff the balance hit 0. Recompute the balance yourself: `total_centavos − amount_paid_centavos − Σ(approved, non-deleted utang_payments)`. Negative proof of "not in the queue": `sales?id=eq.<s>&select=batch_id,status` unchanged and `notifications?type=eq.utang_payment&ref_id=eq.<paymentId>` exists (title `₱X utang payment from <payer>`).

**T9 S6 — void:** `utang_payments?id=eq.<p>&select=deleted_at,owner_note` (**omit** `deleted_at=is.null`) → `deleted_at` set, `owner_note='Voided by the owner'`. `sales?id=eq.<s>&select=settled_at` → back to NULL. Recompute the balance → risen by **exactly** the voided amount. `notifications?type=eq.utang_payment_voided&ref_id=eq.<p>`. Admin-refusal proof: call `fn_void_utang_payment` on an admin token with a **live** payment id → `Only the owner can void a payment`.

**T10 S3/S4/S7 — card number:** `warranties?id=eq.<w>&select=warranty_serial` → **uppercased, trimmed** value; empty save → `null`. Duplicate: the second warranty's `warranty_serial` is unchanged.

**T10 S8/S9 — repair claim:** `warranty_claims?id=eq.<c>&select=status,resolution,shop_id,requested_by,approved_by,approved_at,review_note`. Repair approval writes **nothing else** — assert `stock_movements` count for that engine is unchanged.

**T10 S10 — replace approval (four writes):**
1. `losses?...&select=status,reason,qty,value_centavos,reviewed_by,description` → born `status='approved'`, `reason='warranty'`, `qty=1`, `value_centavos` = the **replacement's** `engines.cost_centavos`, `description='Warranty replacement to <customer>'`. It never passes through the queue.
2. `stock_movements?engine_id=eq.<replacement>` → `movement_type='loss'`, `qty_change=-1`, `shop_id=<shop>`, `note='warranty replacement'`; **and** `stock_movements?engine_id=eq.<defective>` → `movement_type='return'`, `qty_change=+1`, **`shop_id IS NULL`** (= master), `note='defective warranty return (for supplier RMA)'`.
3. `engines?id=eq.<replacement>&select=status,customer_id,sold_at` → `sold`; `engines?id=eq.<defective>&select=status,shop_id` → `status='defective'`, `shop_id NULL`.
4. `warranties?id=eq.<w>&select=engine_id,warranty_serial,updated_at` → `engine_id` **repointed** to the replacement, `warranty_serial` **unchanged** (the plan's "card number survives").

**T10 S11 — refund approval:** `expenses?...&select=scope,shop_id,source,status,amount,description,approved_by` → `scope='company'`, `shop_id NULL`, `source='owner'`, `status='approved'`, `amount = refund_centavos`, `description='Warranty refund to <customer>'`; `expense_categories?name=ilike.warranty refunds` exists. Defective engine → `status='defective'`, `shop_id NULL`, movement note `defective warranty return (refunded; for supplier RMA)`. **No** loss row.

**T10 S12 — reject:** `warranty_claims.status='rejected'`, `review_note` = trimmed note, `approved_by`/`approved_at` **stamped**; assert `stock_movements` for both engines unchanged and no new `losses`/`expenses`.

---

## D) ORDERING + HAZARDS

**Global order.** Task 8 → Task 10 (Task 10's precondition *is* T8 S8's approved engine sale). Task 9 is independent of both **except** that its precondition — an approved partial-payment sale — is cheapest to produce inside the Task 8 batch (record a partial sale as SHOP, submit, approve in T8 S3). Recommended: **T8 S1–S9 → T9 S1–S7 → T8 S10–S12 → T10 S1–S13**. Doing T8's Reviewed-History block *after* T9 gives it a voided payment and a settled sale to page through.

**Intra-task dependencies.**
- T8 S1 (empty states) is only observable when the queue is empty **across all shops**. Either run it first, before any fixture is submitted, or accept that it is unverifiable and log it as blocked. Do **not** clear the queue by approving seeded rows — approval is irreversible.
- T8 S2 needs a batch containing: ≥1 engine line (for `Engine sale` / per-line `Engine` / the strip), ≥1 questioned item (so run S4 first, or question a throwaway item), and a suki-card sale (for the badge). `at floor` needs a deliberate post-record cost raise as Gerry — otherwise skip it.
- T8 S4 must precede T8 S2's questioned-caption assertion and T8 S6's "questioned excluded" assertion.
- T8 S6 needs a batch with **≥2 pending items and 0 questioned**; a `legacy-<shop>` group needs a row with `batch_id IS NULL`, which the app cannot create — **verify a legacy group exists first** (`sales?batch_id=is.null&status=in.(pending,questioned)`), otherwise mark that half of the step unverifiable rather than faking it.
- T8 S7 needs two shop expenses: one on an **active** category, one on a **proposed** one — plus a third if you want to exercise remap (approve-as-proposed consumes the proposal). Approve-all cannot remap, so the remap expense must be approved per-card **before** any approve-all touches its batch.
- T8 S11's payment arm needs a real `utang_payment` → run **T9 S3 first**; the "Settled" badge needs a payment that zeroes the balance; the expense arm needs `receipt_image_path` set (upload one when recording the shop expense — `makePng()` in qa-lib).
- T9 S4 requires ≥1 recorded payment on that receivable (the note lives inside the expanded history) → **after** T9 S3.
- T9 S6 consumes a live payment; T9 S1's `N voided` counter is only visible **after** S6 → assert it in S6, not S1.
- T10 S4 needs a **second** warranty on the same shop → approve two engine sales in T8 S8, or use a seeded one that shop sold.
- T10 S6 needs `shop2` to have sold **no** engine matching your fixture — verify, don't assume.
- T10 S10 requires the shop to hold **≥1 other `delivered` engine** (deliver one first, or the File-claim button is permanently disabled and the step's ❌ assertion cannot fire). It also **consumes** that engine (booked out as a loss).
- T10 S10 destroys the S3 fixture's engine binding — assert `warranty_serial` survives **before** moving on, and don't reuse the defective serial afterwards (it is `defective`, `shop_id NULL`).
- T10 S13's `/movements?tab=engines&serial=<SN>` assertions must come **after** T8 S8 (warranty node) and after S9/S10/S12 (claim nodes).

**Irreversible actions — fixture discipline.** Approving decrements `stock_levels`, appends to the append-only `stock_movements`, freezes COGS and can mint a warranty; voiding, cancelling a claim and approving a claim are equally one-way. **Only ever act on rows this run created**, marked `ZZ-QA`. Never address a card or row positionally — the README records an `nth()` mis-address that resolved a real shop's discrepancy.

**Settings values another agent may be changing concurrently.**
- `settings.default_warranty_months` — read **inside** `fn_approve_sale` at T8 S8. Read the engine → model → settings chain at the moment of assertion, or seed the engine model with an explicit default so `settings` is out of the chain. A hardcoded 12 will flap.
- `settings.warranty_expiry_alert_days` — drives the shop's `expiring_soon` badge, the "N warranties expiring soon." banner, and the `Expiring soon` status filter on `/shop/warranties`. The **owner** registry uses a hardcoded 30 instead (B10.42), so never carry an assertion across the two pages, and never hardcode a count.
- `settings.business_name` / address / phone / `receipt_footer` — reachable only by following a `Receipt` link (`/receipt/<saleId>`, `target=_blank`). Read `public_settings` at assertion time; the browser **tab title** `… · Gerwin Trading` is a hardcoded literal in `app/layout.tsx` and is safe.
- Suki rates are **frozen** onto the sale at record time — a mid-run dial change does not move the badge. `/receivables` and Reviewed History read **no** settings at all.

**Volatile global state — never hardcode a number.** All approval tab badges, the `/receivables` summary cards and tab badges, the warranties tab counts, the Reviewed-History `total`/`pageCount`/range counter, and every sidebar nav badge are **global across all shops**. Capture a baseline immediately before acting and assert **deltas**, or pin the query to your fixture (`?q=<ZZ-QA token>` / `?shop=<throwaway shop uuid>`).

**Realtime will move the DOM under you.** `/approvals` subscribes to INSERT/UPDATE/DELETE on `sales`, `losses` **and** `expenses` across all shops, debounces 400 ms and calls `router.refresh()`, popping `New submission arrived` on any flip to `pending`. Re-query every locator after any await >400 ms; never hold an `ElementHandle`; prefer web-first `expect(locator)` over read-then-compare; use `toast(page,{not: previous})` with a regex, not equality.

**Concurrency failure to expect and tolerate.** `Sale already reviewed (status: approved)` / `Loss already reviewed …` / `Expense already reviewed …` — the most likely real failure with two QA agents on one queue. Also: since 0106 a shop can still **withdraw** (soft-delete) a `pending` item, producing `Sale not found` on approve. Treat both as environment noise, not app defects, and re-verify the row is still live via `dbAuth` immediately before the click.

**Scrolling.** The window never scrolls on any of these pages (shell root is `h-svh overflow-hidden`). `page.evaluate(window.scrollTo)` does nothing. Use `scrollIntoViewIfNeeded()` on the sentinel — `/approvals` reveals 5 at a time (batches on All, items on type tabs), `/receivables` and `/shop/receivables` 20 at a time. Reviewed History sits **below** the entire pending queue.

**Two traps that produce false results rather than failures.** (1) `innerText` applies `text-transform` — every detail-sheet section heading and field label, and the Reviewed-History `<th>`s, read back in CAPS; match case-insensitively. (2) Don't assert absence with body text after a search — every empty state on these surfaces quotes your search term back; assert the row/locator count is 0.