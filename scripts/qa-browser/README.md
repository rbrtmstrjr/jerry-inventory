# Browser QA harness

Drives the real UI in Chromium for the manual-QA sweep in
`docs/superpowers/plans/2026-08-01-full-qa-sweep.md`. This is **not** part of
`npm test` — `test-all.mjs` only picks up `test-*.mjs` in `scripts/`, so nothing
here runs automatically.

```bash
npm run dev                                   # the app must be up on :3000
node scripts/qa-browser/task4a.mjs            # Task 4, Steps 1–9 · 13 · 18
node scripts/qa-browser/task4b.mjs            # Task 4, Steps 10–12 · 14–17
node scripts/qa-browser/task5a.mjs            # Task 5 as ADMIN (price + retire locks)
node scripts/qa-browser/task5b.mjs            # Task 5 as GERRY (owner-only powers)
node scripts/qa-browser/task6a.mjs            # Task 6, Steps 1–8  (delivery lifecycle)
node scripts/qa-browser/task6b.mjs            # Task 6, Steps 9–12 (transfers + returns)
node scripts/qa-browser/task7.mjs             # Task 7 (stock alerts + purchase list)
```

Playwright is not a project dependency; `qa-lib.mjs` imports it by absolute path
from gstack's `node_modules`, and the browsers are already installed there.

## Why not the `browse` server

The gstack `browse` CLI keeps a background server between calls. During Task 4 it
crashed on roughly every other invocation and lost the session, so a 19-step task
could never run end to end, and `browse chain` deadlocks on the same start-lock.
One Playwright process per task fixes both, and gives real input events — which
matters, because **Radix ignores synthetic pointer events**. A `dispatchEvent`
`pointerdown`/`pointerup` pair leaves a `Select` unchanged; only a real click or
keyboard input selects an option.

## Gotchas this harness already encodes

- **`role="combobox"` takes no accessible name from its content** (ARIA), so
  `getByRole("combobox", { name: … })` never matches. Locate by text:
  `page.locator('button[role="combobox"]').filter({ hasText: "Pick item" })`.
- **Never remove `[data-sonner-toast]` nodes.** sonner owns them; deleting them
  makes React throw `insertBefore … not a child of this node` on its next
  update — which reads exactly like an app crash. `clearToasts()` waits them out
  instead.
- **Race the success dialog against the refusal toast.** Receiving succeeds with
  a *dialog* ("Stock received"), not a toast. Waiting for the dialog first burns
  the toast's lifetime, so a refusal looks like silence and a saved receiving
  looks like a failure.
- **Form inputs are `aria-label`led, not `<label>`led** in the line grids —
  `getByLabel("Unit cost in pesos")`, `"Quantity"`, `"Serial number"`,
  `"Cost in pesos"`, `"Price in pesos"`. Targeting "the last decimal input"
  instead will clobber `#rcv-paid`.
- **Supplier context is debounced ~350 ms plus an RPC** — allow ~2.5 s after
  picking a supplier before asserting on the "Owed now …" caption.
- **`getByRole(role, { name })` matches a SUBSTRING by default.** `Actions for
  ZZ-QA Widget 1` also matches `… 1 dup`, and rows are newest-first, so
  `.first()` silently drives the wrong row — every edit lands somewhere else and
  the assertions "fail" against an untouched product. Pass `exact: true`.
- **Don't assert absence with body text after a search.** The empty state quotes
  the search term back, so a retired product's name is still on the page. Assert
  the row is gone (`Actions for <name>` count is 0).
- **Success is sometimes a dialog, sometimes a toast.** Receiving ends in a
  "Stock received" dialog; a product edit ends in a `Part updated` toast.
- **Inline row controls carry `aria-label`s** — `Rename <cat>`, `Save <cat>`,
  `Retire <cat>`, `Actions for <part>`, `Suppliers & prices for <part>`. Use
  them; filtering a `tr, li, div` container by text hits the wrong row.
- **Buttons that submit an inline form start disabled** (`Add category` until a
  name is typed). Fill first, then click — otherwise Playwright waits 30 s on a
  permanently-disabled element.
- **NEVER address a row positionally on a page with seeded data.** `nth(i)` over
  `getByRole` desynced from the DOM and resolved another shop's discrepancy —
  a real, irreversible stock movement. Find the row's own element with
  `evaluateHandle` (smallest ancestor containing your marker AND exactly one
  matching button), click that handle, and re-check the dialog names your
  fixture before submitting.
- **Some forms need an explicit "Add" after picking an item** (shop transfers,
  return-to-admin). Picking alone leaves the submit disabled.
- **`session(browser, role, opts)`** gives a second/third signed-in context, so
  an ADMIN → SHOP → SHOP 2 flow needs no re-login. Roles: `owner`, `admin`,
  `shop`, `shop2`. Options:
  - `viewport` + `isMobile` — for the mobile sweep. Use the exported
    `VIEWPORTS` (`mobile390`, `iphone14promax`, `iphonese`, `desktop`);
    `isMobile: true` also sets `hasTouch`, which the map picker needs.
  - `clearLocalStorage: true` — REQUIRED on the shop app. A stale
    `jm-sale-draft-v3` rehydrates a whole cart *including the customer name*,
    which makes every "a customer is required" assertion pass vacuously.
  - `stubPrint: true` — replaces `window.print()` with a counter + synthetic
    `afterprint`. Headless Chromium otherwise resolves `print()` immediately
    and the receipt iframe self-removes after 500 ms.
- **Every context is `timezoneId: "Asia/Manila"`.** `business_date` /
  `ph_today()` are Philippine time and date-fns renders in the browser's zone —
  a UTC context makes "today" wrong either side of midnight.
- **Re-runs must not reuse the PREVIOUS run's fixture.** Task 7 looked up "a
  request with a custom line" without filtering on status and kept finding one
  an earlier run had already dismissed — which then failed four downstream
  assertions for reasons that had nothing to do with the app. Scope every
  fixture lookup to the state the step needs, or create a fresh one.
- **Several tables are SOFT-deleted** (`shop_reorder_levels`, parts, categories,
  utang payments). Always add `&deleted_at=is.null` or a delete looks like it
  never happened.
- **`next dev` compiles routes on demand**, so a cold navigation can exceed
  Playwright's 30 s default; `goto()` uses 60 s and retries once.

## Verifying persisted state

`dbAuth(role)` returns a read-only PostgREST query function so a step can check
what was actually written rather than scraping the rendered table. It refuses to
run unless `SUPABASE_ENV=staging`. Keep it read-only: writes belong in the app
under test, and `scripts/_env-guard.mjs` is what protects the write scripts.

## Fixtures

These scripts save real rows. Everything they create is prefixed `ZZ-QA` /
`ZZQA`. `sweep-test-fixtures.mjs` targets `ZZ-TEST` and will **not** remove them
— see the fixture table in `docs/superpowers/plans/2026-08-01-qa-bugs.md`.

## Gotchas found during Tasks 14 · 11 · 1 · 3 · 2 (bug log B)

- **`innerText` applies `text-transform`.** Section headings styled `uppercase`
  come back as `EMPLOYEES (0)` and `TRANSACTION HISTORY`, so a case-sensitive
  regex on the real copy fails. Match case-insensitively. This produced three
  false failures before it was spotted.
- **`[role="alert"]` is not unique.** Next injects
  `#__next-route-announcer__` with `role="alert"` and empty text on every page,
  so `.first()` reads `""` and a real error looks absent. Filter to non-empty
  text, or read all of them.
- **Scope `button[role="combobox"]` to the dialog.** Unscoped, it resolves to
  the DataTable's "Rows per page" select sitting *behind* the modal overlay;
  Playwright then retries the click for the full 30 s while the overlay eats it.
- **PostgREST caps an unpaged select at 1,000 rows.** A count of exactly 1000 is
  almost always truncation, not data — page with `limit`/`offset` before
  concluding a UI number is wrong.
- **Never assert a sign-in refusal with a fixed timeout.** `next dev` compiles
  `/shop` and `/dashboard` on demand, so a cold first sign-in can take far
  longer than a warm one — and a refusal *also* leaves you on `/login`, so the
  two are indistinguishable. Wait on the URL change, then assert the specific
  message ("Wrong email or password." / "This account has been disabled…").
- **`ViewToggle` is `aria-label="Card view"` / `"Table view"`.** Card tiles, the
  `Out of stock` / `Low` badges and the "N of M items" counter render in **card
  view only**; table is the default.
- **Forcing an upload failure:** `page.route("**/storage/v1/object/product-images/<prefix>/**", r => r.abort())`
  is a clean way to exercise the partial-failure paths (shop logo saves the row
  anyway; staff photo aborts the whole save).
- **Verifying a `next.config.ts` change needs a dev-server restart** — it is not
  hot-reloaded, and Next 16 refuses to start a second dev server for the same
  directory, so you cannot side-step it with a spare port.

## Gotchas found during Tasks 13 · 12 · 15 (bug log B, round 2)

- **`DataTable`'s search box is internal state.** Anything that renders the same
  data beside the table (e.g. the Expenses print sheet) cannot see it. Pass the
  optional `onVisibleRowsChange` prop to receive the post-search rows.
- **Never key an effect on the `data` prop to push rows into parent state.**
  Callers build `data` inline (`expenses.filter(...)`), so its identity changes
  every render — an effect that depends on it and sets parent state is an
  infinite loop, and it hits the error boundary. `DataTable` now emits only when
  the row SET actually changes, which is self-limiting whatever the caller does.
- **To address a row, walk DOWN not UP.** The smallest ancestor that contains
  your marker AND exactly one matching button is the row. Walking up from each
  candidate button settles on a neighbour when several rows are on screen — that
  is how a first attempt dismissed the wrong category proposal.
- **Not every refusal opens a dialog.** Dismissing an in-use category proposal
  toasts immediately and opens nothing, so a "does the confirm dialog name my
  fixture?" check passes vacuously. Assert the toast names your fixture.
- **The `uppercase`/`innerText` trap again:** the Movements column header row and
  the count sheet's "ENGINES ON HAND — TICK IF PRESENT" heading both read back in
  caps. Match case-insensitively by default.
- **Count entry rows carry `aria-label="Counted quantity for <part>"`** — filter
  with the "Find an item to count" box, then drive the field by that label. No
  positional addressing needed anywhere on that page.
- **Assert structure, not totals, on `/movements`.** With another agent writing,
  any count or balance you capture is stale immediately. The stock card computes
  its balance and the live on-hand quantity in the SAME render, so its own
  "Closing balance matches on-hand stock" banner is the honest thing to assert.

## Gotchas found during Tasks 0 · 20 · 16 (bug log B, round 3)

- **Measure the EFFECTIVE tap target, not the bounding box.** A 16px checkbox
  wrapped in a `<label>` is tapped by the whole label, and an
  `after:-inset-*` pseudo-element widens the hit area without changing the box.
  Measuring the box alone reported 53 "16×16" controls that are all comfortably
  tappable; only one was real. Union the box, its `::after`, and any `<label>`
  ancestor.
- **`parseInt` truncates, it does not reject.** `parseInt("12.5") === 12`, so
  `isNaN(parseInt(x))` is not integer validation — it silently accepts and
  changes the value. Test numeric fields with `12.5`, `12abc` and `1e3`, not
  just `abc` (bug B12).
- **A `type="email"` input is refused by the BROWSER**, before any handler runs,
  so there is no toast to assert. Check `el.checkValidity()` instead of
  expecting app copy that can never fire.
- **Don't grep for the word "secret".** The System panel's own reassurance says
  *"no key or secret is ever shown here"*, so a naive `/secret/i` fails on the
  sentence promising the opposite. Match secret SHAPES (`eyJ…`, `service_role`,
  a long base64 blob, a connection string).
- **Conditional lines are absent, not broken.** The notifications panel renders
  its pending-dispatch line as `{pending > 0 && …}` — assert against the real
  queue depth, not the presence of the text.
- **"New Receiving" opens an inline Card, not a dialog.** The overlays worth
  mobile-testing are the ones INSIDE it (New product / New model / Bulk
  products).
- **Restoring the settings row must go through the UI** — `dbAuth` is read-only
  and `process.on("exit")` cannot await. Capture the whole row first, restore in
  `finally`, then DIFF it field-by-field to prove the restore landed.

## Gotchas found during Task 19 (bug log B, round 4)

- **The `uppercase` + `innerText` trap bit FOUR more times in one script** — the
  receipt letterhead, the transfer slip's "Approved" header, and the return
  slip's "Good" header all render in caps. Stop writing case-sensitive text
  assertions against print documents; `task19.mjs` routes every one through a
  `says(haystack, needle)` helper that lowercases both sides.
- **"Paid via" and the payment method are separate spans**, so `innerText` puts
  a newline between them — `/Paid via cash/` never matches. Assert the two parts.
- **The 58 mm marker is inside `<style dangerouslySetInnerHTML>`.** Only
  `page.content()` sees it; no text or role query will.
- **The receipt's branch logo has `alt=""`** (it is decorative — the branch is
  named in text right below). `getByRole("img")` cannot match it; use
  `img[alt=""]`. Its absence is the signal that the anchor fallback drew instead.
- **No shop ships with a logo.** To exercise that branch, add one to a shop that
  is neither the anchor-fallback control nor another agent's, and remove it in
  `finally`.
- **A slip's letterhead anchor is checked on the PARENT's class**, not the svg:
  `print:border print:bg-transparent` is what turns the filled blue box into an
  outline for print.
