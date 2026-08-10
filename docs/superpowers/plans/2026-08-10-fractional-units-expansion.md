# Fractional Units Expansion (m · ft · roll) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Gerwin Trading sell part-metres, part-feet and part-rolls in tenths, exactly as it already sells part-kilos.

**Architecture:** No schema change. `units.allows_fractional` is read live by every layer (`fn_assert_qty` joins `units` per call; the Record Sale form reads the table through `useUnits`), so this is a one-row data migration plus one string of user-facing copy. The work is almost entirely *proving* it, not building it.

**Tech Stack:** Postgres (Supabase), Next.js 16 App Router, React 19, Node test scripts (`scripts/test-*.mjs`), Playwright browser QA (`scripts/qa-browser/`).

**Spec:** `docs/superpowers/specs/2026-08-10-fractional-units-expansion-design.md`

## Global Constraints

- **Never commit or push.** The user performs every `git` operation. Where a step says "commit", stage nothing and instead report the file list to the user. This overrides the writing-plans template.
- **Never apply a migration.** `dbAuth()` is read-only PostgREST and the Supabase CLI is linked to **PRODUCTION**. Every migration is applied by the user pasting SQL into the **staging** SQL editor. Tasks that need one end by handing the user the file path and waiting.
- **Granularity is ONE decimal.** `numeric(12,1)` is unchanged. `0.25` stays refused. Do not widen any column.
- **Reorder levels stay whole numbers.** They are a threshold, not a measurement.
- **Engines stay pinned at quantity 1.** Do not touch any engine quantity path.
- **`roll` is counted BY THE ROLL.** `0.5 roll` — never unit-converted to metres.
- **Browser QA is mandatory** for the UI change, not optional. `test-fractional-qty` was once 41/41 green while the counter still refused `0.5`.
- Money is integer centavos; quantity helpers live in `lib/format.ts`.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `supabase/migrations/0130_more_fractional_units.sql` | flips `m`/`ft`/`roll`, and refuses to silently no-op | create |
| `scripts/test-fractional-qty.mjs` | asserts the vocabulary is exactly `ft,kg,m,roll` | modify (~line 116) |
| `components/unit-select.tsx` | picker copy, currently weight-specific | modify (line ~76) |
| `scripts/qa-browser/fq20-fractional-units.mjs` | sells 1.5 m through the real UI, checks the DB | create |
| `CLAUDE.md` | records that `kg` is no longer the only fractional unit | modify (~line 1230) |

---

### Task 1: Migration 0130 + the vocabulary assertion

**Files:**
- Create: `supabase/migrations/0130_more_fractional_units.sql`
- Modify: `scripts/test-fractional-qty.mjs:113-117`

**Interfaces:**
- Consumes: `public.units(code, label, allows_fractional, sort_order, deleted_at)` from 0114; the `ft` row from 0127.
- Produces: exactly four fractional unit codes — `ft`, `kg`, `m`, `roll`. Task 2's browser QA relies on `m` being fractional.

- [ ] **Step 1: Update the assertion that currently pins the vocabulary to `kg`**

`scripts/test-fractional-qty.mjs` line 116 reads:

```js
  check("only kg is fractional today",
    (units ?? []).filter((u) => u.allows_fractional).map((u) => u.code).join() === "kg",
    (units ?? []).filter((u) => u.allows_fractional).map((u) => u.code).join());
```

Replace that whole `check(...)` call with:

```js
  // The vocabulary is asserted EXACTLY, so an accidental flip (someone making
  // `pc` fractional and letting a shop sell half a spark plug) fails the build.
  // A future intentional flip must edit this line — that friction is the point:
  // the decision then shows up in a diff instead of living only as DB state.
  //
  // SORTED: the select has no .order(), so PostgREST may return these rows in
  // any order. Comparing an unsorted join() would flap between runs.
  const fractionalCodes = (units ?? [])
    .filter((u) => u.allows_fractional)
    .map((u) => u.code)
    .sort()
    .join(",");
  check("exactly kg, m, ft and roll are fractional (0130)",
    fractionalCodes === "ft,kg,m,roll", fractionalCodes);
  // `pc` is already asserted a few lines above — do not double-count it.
  for (const whole of ["set", "box", "pair"]) {
    check(`${whole} is NOT fractional`, byCode[whole]?.allows_fractional === false);
  }
```

- [ ] **Step 2: Run the suite to verify it FAILS**

Run: `node scripts/test-fractional-qty.mjs`

Expected: FAIL on `exactly kg, m, ft and roll are fractional (0130)`, reporting `kg`. The `pc/set/box/pair` checks pass already. This failure is the proof the migration has not been applied yet — do not proceed past it by editing the assertion back.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0130_more_fractional_units.sql`:

```sql
-- ---------------------------------------------------------------------------
-- 0130 — `m`, `ft` and `roll` become splittable, alongside `kg`.
--
-- Gerwin sells rope, wire, cable and hose by the metre, bronze and Ehe pipe by
-- the foot, and a part roll AS A ROLL. Until now `kg` was the only unit a
-- customer could buy a part of.
--
-- THERE IS NO SCHEMA CHANGE HERE, AND THAT IS THE POINT. 0114 made the
-- vocabulary DATA precisely so this day would be an UPDATE: fn_assert_qty
-- joins `units` on every call, and the Record Sale form reads the table
-- through useUnits, so both the server rule and the editable quantity box
-- follow this row the moment it flips. 0127 wrote the prediction down —
-- "selling pipe by the half-foot later is an UPDATE on this row, not a
-- migration".
--
-- Granularity stays at ONE decimal. 0.5 ft (6 inches) is expressible; 0.25 ft
-- is NOT, and is refused by name. Confirmed with Gerry 2026-08-10 — pipe is
-- quoted in halves. Two decimals would mean ALTERing all fifteen quantity
-- columns and redoing every tenths CHECK: a 0116-class migration, out of scope.
--
-- `roll` is counted BY THE ROLL — 0.5 roll, never converted to metres. The
-- product's unit stays what the shop calls it; the fraction says how much of
-- it was sold.
--
-- Existing whole quantities stay valid, no backfill: the flag only PERMITS
-- tenths from here on, and the seven `check (qty = round(qty, 1))` constraints
-- already cover the quantity columns.
-- ---------------------------------------------------------------------------

update public.units set allows_fractional = true
 where code in ('m', 'ft', 'roll');

-- A missing or retired code makes the UPDATE a SILENT no-op — the exact
-- failure mode that cost this project 0125 (a rounded audit row) and the
-- 2026-08-09 row-cap outage (a truncated response with no error). The
-- vocabulary was verified on STAGING; production's `roll` row is unconfirmed.
-- Fail loudly rather than report success.
do $$
declare v_missing text;
begin
  select string_agg(c, ', ') into v_missing
    from (select unnest(array['m', 'ft', 'roll']) as c) x
   where not exists (
     select 1 from public.units u
      where u.code = x.c
        and u.allows_fractional
        and u.deleted_at is null);
  if v_missing is not null then
    raise exception
      '0130 did not flip these units (missing or retired): %', v_missing;
  end if;
end $$;
```

- [ ] **Step 4: HUMAN STEP — apply the migration to staging**

Stop and tell the user:

> `supabase/migrations/0130_more_fractional_units.sql` is ready. Please paste it into the **staging** SQL editor and run it. Expect "Success. No rows returned". If it raises `0130 did not flip these units`, tell me which codes it named — that means staging's vocabulary differs from what I read.

Do not continue until the user confirms.

- [ ] **Step 5: Run the suite to verify it PASSES**

Run: `node scripts/test-fractional-qty.mjs`

Expected: PASS, `55 passed, 0 failed` (52 before, +3 new whole-unit checks; the vocabulary check is changed, not added). If `exactly kg, m, ft and roll are fractional` still fails and reports something like `ft,kg,m` then `roll` is absent on staging — report that rather than relaxing the assertion.

- [ ] **Step 6: Report for commit (do NOT commit)**

Tell the user these files are ready:
```
supabase/migrations/0130_more_fractional_units.sql   (new)
scripts/test-fractional-qty.mjs                      (modified)
```
Suggested message: `feat(db): 0130 — m, ft and roll join kg as splittable units`

---

### Task 2: Picker copy + browser QA + docs

**Files:**
- Modify: `components/unit-select.tsx:74-78`
- Create: `scripts/qa-browser/fq20-fractional-units.mjs`
- Modify: `CLAUDE.md:1230`

**Interfaces:**
- Consumes: the four fractional codes from Task 1; `units.allows_fractional` as read by `useUnits`.
- Produces: nothing other tasks depend on. This is the final task.

- [ ] **Step 1: Fix the weight-specific copy**

In `components/unit-select.tsx`, this block labels **every** fractional unit as weight:

```jsx
            {u.allows_fractional && (
              <span className="ml-2 text-xs text-muted-foreground">
                sold by weight
              </span>
            )}
```

Replace with:

```jsx
            {u.allows_fractional && (
              /* Unit-neutral since 0130: metres, feet and rolls are splittable
                 too, so "sold by weight" was wrong for three of the four. */
              <span className="ml-2 text-xs text-muted-foreground">
                sold in parts
              </span>
            )}
```

- [ ] **Step 2: Write the browser QA**

Create `scripts/qa-browser/fq20-fractional-units.mjs`. Model it on `fq18-leading-dot-qty.mjs`, which already provisions a fixture at Ternate and drives the real UI:

```js
// FQ20 — a METRE product is splittable at the counter, exactly like a kilo.
//
// 0130 flipped m/ft/roll to allows_fractional. No code decides this: the form
// asks the units table. This proves the whole chain end to end, because an
// RPC-level suite cannot see the form or the server action — test-fractional-qty
// was once 41/41 green while the counter still refused 0.5.
//
// Provisions its own m product at Ternate. Remove with
// `node scripts/qa-browser/fq-cleanup.mjs --yes`.
import { createClient } from "@supabase/supabase-js";
import {
  launch, session, goto, shot, check, step, summary, dbAuth, CREDS,
} from "./qa-lib.mjs";
import { readEnvFile } from "../_env-guard.mjs";

const env = readEnvFile();
const TERNATE = "a46c9c78-a995-46b3-954f-7836ab161254";
const NAME = `ZZ-QA Rope ${Date.now().toString(36).slice(-4).toUpperCase()}`;
const AVAILABLE = 8;
const PRICE_PESOS = 40; // 1.5 m -> P60.00

async function clientFor(role) {
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { error } = await c.auth.signInWithPassword({
    email: CREDS[role].email, password: CREDS[role].pass,
  });
  if (error) throw new Error(`${role}: ${error.message}`);
  return c;
}

const q = await dbAuth("owner");
const { browser } = await launch({ headless: true });

try {
  step("Provision 8 m of a METRE product at Ternate");
  const owner = await clientFor("owner");
  const sup = (await q("suppliers?deleted_at=is.null&select=id&limit=1"))[0];
  const { error: rErr } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: sup.id,
    p_note: `ZZ-QA metre ${NAME}`,
    p_parts: [{
      qty: AVAILABLE, unit_cost_centavos: 1000,
      new_part: { name: NAME, unit: "m", price_centavos: PRICE_PESOS * 100, reorder_level: 0 },
    }],
    p_engines: [], p_payment_status: "paid", p_amount_paid: null,
    p_override: true, p_override_reason: "ZZ-QA test run",
  });
  check(!rErr, "received 8 m into master — the RPC accepts a metre product", rErr?.message);
  if (rErr) throw new Error("setup failed");

  const part = (await q(`parts?name=eq.${encodeURIComponent(NAME)}&select=id`))[0];
  const { data: delId, error: dErr } = await owner.rpc("fn_deliver_stock", {
    p_shop_id: TERNATE, p_note: "ZZ-QA metre",
    p_parts: [{ part_id: part.id, qty: AVAILABLE }], p_engine_ids: [],
  });
  check(!dErr, "delivered to Ternate", dErr?.message);

  const shopClient = await clientFor("shop");
  const lines = await q(`delivery_lines?delivery_id=eq.${delId}&select=id,qty`);
  const { error: cErr } = await shopClient.rpc("fn_confirm_delivery", {
    p_delivery_id: delId,
    p_lines: lines.map((l) => ({ line_id: l.id, qty_received: l.qty, shop_note: null })),
    p_note: null,
  });
  check(!cErr, "confirmed 8 m", cErr?.message);

  step("The counter offers a TYPED quantity box for a metre product");
  const shop = await session(browser, "shop", { clearLocalStorage: true, stubPrint: true });
  await goto(shop.page, "/shop/record-sale");
  await shop.page.waitForTimeout(2500);
  await shop.page.getByPlaceholder(/search/i).first().fill("ZZ-QA Rope");
  await shop.page.waitForTimeout(1200);
  await shop.page.getByRole("button", { name: new RegExp(NAME, "i") }).first().click();
  await shop.page.waitForTimeout(900);

  const box = shop.page.getByLabel(/quantity in m/i).first();
  check(
    (await box.count()) > 0,
    "a metre line has a typed quantity box (a `pc` line has none)"
  );

  step("Sell 1.5 m");
  await box.fill("");
  await box.type("1.5", { delay: 80 });
  await box.blur();
  await shop.page.waitForTimeout(800);
  check((await box.inputValue()) === "1.5", "1.5 is accepted", await box.inputValue());

  await shop.page.getByRole("button", { name: /save sale/i }).first().click();
  await shop.page.waitForTimeout(3500);

  const sold = await q(
    `sale_lines?part_id=eq.${part.id}&select=qty,line_total_centavos,sales!inner(deleted_at)`
  );
  check(sold.length === 1, `one sale line recorded (${sold.length})`);
  if (sold.length === 1) {
    check(Number(sold[0].qty) === 1.5, `stored quantity is 1.5`, String(sold[0].qty));
    check(
      Number(sold[0].line_total_centavos) === Math.round(PRICE_PESOS * 100 * 1.5),
      `money is round(P${PRICE_PESOS} x 1.5) = P60.00`,
      String(sold[0].line_total_centavos)
    );
  }
  await shot(shop.page, "fq20-metre-sold");

  console.log(`\nFIXTURE: ${NAME} — remove with fq-cleanup.mjs --yes`);
  console.log("CONSOLE ERRORS:", (shop.errors ?? []).slice(0, 5));
} catch (e) {
  console.error("\nFQ20 THREW:", e.message);
  check(false, `run failed: ${e.message}`);
} finally {
  const failed = summary();
  await browser.close();
  process.exit(failed ? 1 : 0);
}
```

- [ ] **Step 3: Run the browser QA**

Start the dev server first (it must be on :3000 — `next dev` moves to 3001 if the port is taken, and the harness would then drive somebody else's app):

```bash
npm run dev          # leave running
node scripts/qa-browser/fq20-fractional-units.mjs
```

Expected: all checks pass, `CONSOLE ERRORS: []`. Do not run `npm run build` at the same time — both write `.next` and the dev server will serve 500s.

- [ ] **Step 4: Sweep the fixtures**

Run: `node scripts/qa-browser/fq-cleanup.mjs --yes`
Expected: `remaining fixture parts: 0` … `clean.`

- [ ] **Step 5: Update CLAUDE.md**

`CLAUDE.md` line 1230 currently reads:

```
to it by FK. Only `kg` is fractional today; selling rope by the metre is an
UPDATE, not a migration. Office writes it, every role reads it (the shop needs
```

Replace those two lines with:

```
to it by FK. **`kg`, `m`, `ft` and `roll` are splittable (0130)**; `pc`, `set`,
`box` and `pair` are not. That expansion was a one-row UPDATE with no schema
change and no code — which is the whole reason the vocabulary is data. Tenths
remain the granularity BY DECISION (Gerry, 2026-08-10): `0.5 ft` is six inches
and expressible, `0.25 ft` is refused, and two decimals would mean ALTERing all
fifteen quantity columns. A `roll` is counted BY THE ROLL — `0.5 roll`, never
converted to metres. Office writes it, every role reads it (the shop needs
```

- [ ] **Step 6: Full verification**

Stop the dev server first (`npm run build` and `next dev` both write `.next`).

```bash
npx tsc --noEmit                 # expect clean
npm test                         # expect 55 suites, 0 failed
npm run build                    # expect exit 0
```

- [ ] **Step 7: Report for commit (do NOT commit)**

Tell the user these files are ready:
```
components/unit-select.tsx                        (modified)
scripts/qa-browser/fq20-fractional-units.mjs      (new)
CLAUDE.md                                         (modified)
```
Suggested message: `feat: metres, feet and rolls sell in tenths`

Then remind them of the production rollout, which is theirs:
1. merge + deploy
2. apply `0130` to **production**
3. no ordering hazard — the app is correct with the flag in either state

---

## Post-Plan Follow-Ups (agreed, not blocking)

- **A Units screen in Settings** (create / rename / retire / toggle splittable) was considered and deferred as YAGNI. Every future flip needs a developer running SQL until it exists — worth revisiting given the 3-year handover.
- **The Record Sale draft restore does not re-clamp against current stock.** `setCart(draft.cart)` restores verbatim and each line carries its own stale `available`, so a draft saved when more stock was on hand can still exceed it. Pre-existing, found 2026-08-10, unrelated to this plan.
