# Owner Stock Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Gerry correct a master stock quantity for a part himself, writing a `correction` ledger entry so the books stay honest and the P&L is untouched.

**Architecture:** One `SECURITY DEFINER` RPC (`fn_correct_master_stock`) is the only way in — it guards `is_primary_owner()`, validates through the existing `fn_assert_qty`, locks the master `stock_levels` row, writes a `correction` movement, then updates the row, all atomically. The app layer is a thin server action plus a dialog, gated by a `correctLocked` prop threaded exactly like the existing `priceLocked` / `retireLocked`.

**Tech Stack:** Postgres (Supabase), PL/pgSQL, Next.js 16 App Router, React 19, TypeScript, Zod, Playwright (QA), Node `.mjs` test suites.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-12-owner-stock-correction-design.md`. Do not exceed its scope.
- **In scope:** master stock (`stock_levels.shop_id IS NULL`), parts only, correction only, Gerry only.
- **Out of scope, do not touch:** shop stock, engines, `losses`, `losses.shop_id`, Monthly Count, `fn_record_count_shortages`, the Edit Product dialog.
- **NEVER commit or push.** The user handles all git operations. Each task ends by reporting for review.
- **Branch:** `feat/owner-stock-correction`, already created off `origin/staging` (`99e768e`).
- **Migrations are applied BY THE USER** in the Supabase SQL editor. Never attempt to apply one.
- **Staging only.** `.env.local` must stay `SUPABASE_ENV=staging`. Never point anything at production.
- Quantity is `numeric(12,1)`. Never `parseInt`, never `z.number().int()` on a quantity — use `parseQty` / `sanitizeQtyInput` / `qtySchema()`.
- Money is integer centavos.
- Comments: two lines maximum, per the repo convention.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/0132_owner_stock_correction.sql` | CREATE the RPC. The whole control lives here |
| `scripts/test-stock-correction.mjs` | Proves the control: authority, validation, ledger invariant, shop stock untouched |
| `app/(owner)/master-inventory/actions.ts` | MODIFY — add `correctMasterStock` server action |
| `app/(owner)/master-inventory/correct-stock-dialog.tsx` | CREATE — the dialog |
| `app/(owner)/master-inventory/parts-table.tsx` | MODIFY — `correctLocked` prop, menu item, dialog wiring |
| `app/(owner)/master-inventory/page.tsx` | MODIFY — pass `correctLocked` |
| `scripts/qa-browser/cs1-correct-stock.mjs` | CREATE — end-to-end UI proof |
| `CLAUDE.md` | MODIFY — "Corrections do not exist" is no longer true |

---

### Task 1: The database control + its test suite

**Files:**
- Create: `supabase/migrations/0132_owner_stock_correction.sql`
- Create: `scripts/test-stock-correction.mjs`

**Interfaces:**
- Consumes: `public.is_primary_owner()`, `public.fn_assert_qty(uuid, numeric, boolean)`, `public.fmt_qty(numeric)` — all existing.
- Produces: `public.fn_correct_master_stock(p_part_id uuid, p_new_qty numeric, p_reason text) returns numeric` — returns the delta applied. Granted to `authenticated`; guarded in-body by `is_primary_owner()`.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-stock-correction.mjs`:

```js
/**
 * 0132 — Owner stock correction: Gerry fixes a wrong MASTER quantity himself.
 *
 * The number is set to what is actually there; the delta is written as a
 * `correction` movement so the ledger still explains the shelf. Refuses to run
 * (exit 2) until 0132 is applied.
 */
import {
  owner, admin, signIn, RUN, check, section, summary,
  provisionShop, seedPart, receive, deliverAndConfirm, cleanup,
} from "./_harness.mjs";

const ADMIN_EMAIL = `zz-corr-${RUN.toLowerCase()}@test.local`;
const ADMIN_PASSWORD = `Zz-test-${RUN}`;
let adminUserId = null;

const masterQty = async (partId) => {
  const { data } = await admin.from("stock_levels")
    .select("qty").eq("part_id", partId).is("shop_id", null).maybeSingle();
  return Number(data?.qty ?? 0);
};
const masterLedger = async (partId) => {
  const { data } = await admin.from("stock_movements")
    .select("qty_change").eq("part_id", partId).is("shop_id", null);
  return (data ?? []).reduce((s, m) => s + Number(m.qty_change), 0);
};
const correct = (client, partId, qty, reason = `ZZ-TEST fix ${RUN}`) =>
  client.rpc("fn_correct_master_stock", {
    p_part_id: partId, p_new_qty: qty, p_reason: reason,
  });

try {
  const shop = await provisionShop("Correction");
  const part = await seedPart({ label: "Corr", unit: "pc" });
  const kgPart = await seedPart({ label: "CorrKg", unit: "kg" });
  await receive({ parts: [{ part_id: part.id, qty: 10, unit_cost_centavos: 1000 }] });
  await receive({ parts: [{ part_id: kgPart.id, qty: 10, unit_cost_centavos: 1000 }] });

  // ── gate ────────────────────────────────────────────────────────────────
  {
    const { error } = await correct(owner, part.id, 9);
    if (error && /Could not find the function|does not exist/i.test(error.message)) {
      console.error("test-stock-correction: migration 0132_owner_stock_correction.sql is not applied — run it in the SQL editor first.");
      await cleanup();
      process.exit(2);
    }
    check("owner can correct DOWN", !error, error?.message);
    check("master is now 9", (await masterQty(part.id)) === 9);
  }

  section("The ledger still explains the shelf");
  {
    check("master ledger equals master shelf",
      (await masterLedger(part.id)) === (await masterQty(part.id)));
    const { data: mv } = await admin.from("stock_movements")
      .select("movement_type, qty_change, note")
      .eq("part_id", part.id).eq("movement_type", "correction").single();
    check("a correction movement was written", !!mv);
    check("its delta is -1", Number(mv?.qty_change) === -1, String(mv?.qty_change));
    check("the note carries the reason", (mv?.note ?? "").includes(RUN));
  }

  section("Corrections go both ways");
  {
    const { error } = await correct(owner, part.id, 14);
    check("owner can correct UP", !error, error?.message);
    check("master is now 14", (await masterQty(part.id)) === 14);
    check("ledger still equals shelf", (await masterLedger(part.id)) === 14);
  }

  section("Validation");
  {
    const { error: same } = await correct(owner, part.id, 14);
    check("a no-op correction is refused", !!same, "delta 0 should raise");

    const { error: neg } = await correct(owner, part.id, -1);
    check("a negative quantity is refused", !!neg);

    const { error: frac } = await correct(owner, part.id, 2.5);
    check("a `pc` product refuses a fraction", !!frac, frac?.message);

    const { error: kgOk } = await correct(owner, kgPart.id, 2.5);
    check("a `kg` product accepts a tenth", !kgOk, kgOk?.message);

    const { error: tooPrecise } = await correct(owner, kgPart.id, 1.25);
    check("two decimals are refused", !!tooPrecise);

    const { error: noReason } = await correct(owner, part.id, 3, "   ");
    check("an empty reason is refused", !!noReason);
    check("master unchanged after every refusal", (await masterQty(part.id)) === 14);
  }

  section("Authority: Gerry alone");
  {
    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email: ADMIN_EMAIL, password: ADMIN_PASSWORD, email_confirm: true,
    });
    if (cErr) throw new Error(`fixture admin: ${cErr.message}`);
    adminUserId = created.user.id;
    await admin.from("profiles").insert({
      id: adminUserId, full_name: `ZZ-TEST Corr Admin ${RUN}`, role: "admin", shop_id: null,
    });
    const adm = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

    const { error: admErr } = await correct(adm, part.id, 2);
    check("admin is refused", !!admErr, admErr?.message);

    const { error: empErr } = await correct(shop.client, part.id, 2);
    check("employee is refused", !!empErr);

    check("master still 14 after refusals", (await masterQty(part.id)) === 14);
  }

  section("Shop stock is untouched");
  {
    await deliverAndConfirm(shop, { parts: [{ part_id: part.id, qty: 4 }] });
    const { data: before } = await admin.from("stock_levels")
      .select("qty").eq("part_id", part.id).eq("shop_id", shop.id).single();

    const { error } = await correct(owner, part.id, 1);
    check("owner corrects master again", !error, error?.message);

    const { data: after } = await admin.from("stock_levels")
      .select("qty").eq("part_id", part.id).eq("shop_id", shop.id).single();
    check("the shop's quantity did not move",
      Number(before.qty) === Number(after.qty), `${before?.qty} -> ${after?.qty}`);
    check("master is 1", (await masterQty(part.id)) === 1);
  }

  section("No shrinkage is invented");
  {
    const { count } = await admin.from("losses")
      .select("id", { count: "exact", head: true }).eq("part_id", part.id);
    check("no loss row was created", (count ?? 0) === 0, `found ${count}`);
  }
} finally {
  if (adminUserId) await admin.auth.admin.deleteUser(adminUserId);
  await cleanup();
}
summary();
```

- [ ] **Step 2: Run it to confirm it refuses to run**

Run: `node scripts/test-stock-correction.mjs`
Expected: prints `migration 0132_owner_stock_correction.sql is not applied`, exit code 2.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0132_owner_stock_correction.sql`:

```sql
-- 0132 — Owner stock correction (master, parts).
--
-- An admin mis-encodes a quantity at receiving and master is wrong. Until now
-- the only remedy was hand-run SQL: fn_record_count_shortages posts a `loss`,
-- which books shrinkage in the P&L, and that is a lie when the stock never
-- existed. This writes the delta as `correction` instead, which lib/pnl.ts
-- ignores, so the number is fixed and the profit figures do not move.
--
-- Gerry alone (is_primary_owner), matching 0100/0101/0102/0105. The admin who
-- makes the errors must not be able to erase them. stock_movements keeps its
-- append-only property — no write policy is added for anyone.

create or replace function public.fn_correct_master_stock(
  p_part_id uuid,
  p_new_qty numeric,
  p_reason  text
) returns numeric
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_old   numeric;
  v_delta numeric;
  v_name  text;
begin
  if not public.is_primary_owner() then
    raise exception 'Only the owner can correct stock';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Give a reason for the correction';
  end if;

  select name into v_name from parts
   where id = p_part_id and deleted_at is null and merged_into is null;
  if not found then
    raise exception 'Product not found';
  end if;

  -- tenths + the unit rule, from the one authority that already owns them
  perform public.fn_assert_qty(p_part_id, p_new_qty, true);

  -- lock: fn_deliver_stock decrements this same row
  select qty into v_old from stock_levels
   where part_id = p_part_id and shop_id is null
   for update;
  if not found then
    insert into stock_levels (part_id, shop_id, qty) values (p_part_id, null, 0);
    v_old := 0;
  end if;

  v_delta := p_new_qty - v_old;
  if v_delta = 0 then
    raise exception '% is already %', v_name, public.fmt_qty(p_new_qty);
  end if;

  -- contra-entry FIRST, so the ledger always explains the shelf
  insert into stock_movements
    (movement_type, part_id, qty_change, shop_id, actor, note)
  values
    ('correction', p_part_id, v_delta, null, auth.uid(),
     'Stock correction: ' || public.fmt_qty(v_old) || ' -> '
     || public.fmt_qty(p_new_qty) || ' (' || trim(p_reason) || ')');

  update stock_levels set qty = p_new_qty, updated_at = now()
   where part_id = p_part_id and shop_id is null;

  return v_delta;
end $fn$;

revoke all on function public.fn_correct_master_stock(uuid, numeric, text)
  from public, anon;
grant execute on function public.fn_correct_master_stock(uuid, numeric, text)
  to authenticated;
```

- [ ] **Step 4: Ask the user to apply 0132 to STAGING**

Stop and report: "0132 is written. Please run it in the staging SQL editor, then I will run the suite." Do not attempt to apply it.

- [ ] **Step 5: Run the suite until green**

Run: `node scripts/test-stock-correction.mjs`
Expected: every check passes, exit 0.

- [ ] **Step 6: Confirm no existing suite regressed**

Run: `node scripts/test-definer-guards.mjs && node scripts/test-movements.mjs && node scripts/test-fractional-qty.mjs`
Expected: all pass. `test-definer-guards` must accept the new function — `is_primary_owner()` is already in its guard regex.

- [ ] **Step 7: Report for review. Do NOT commit.**

---

### Task 2: The server action

**Files:**
- Modify: `app/(owner)/master-inventory/actions.ts`

**Interfaces:**
- Consumes: `fn_correct_master_stock` from Task 1.
- Produces: `correctMasterStock(input: unknown): Promise<ActionResult>` where `ActionResult` is the file's existing `{ ok: true; id?: string } | { ok: false; error: string }`.

- [ ] **Step 1: Confirm `qtySchema` is imported**

Run: `grep -n "qty-schema" "app/(owner)/master-inventory/actions.ts"`
If absent, add `import { qtySchema } from "@/lib/qty-schema";` beside the other `@/lib` imports.

- [ ] **Step 2: Add the action**

Append to `app/(owner)/master-inventory/actions.ts`:

```ts
const correctStockSchema = z.object({
  part_id: z.uuid(),
  new_qty: qtySchema({ allowZero: true }),
  reason: z.string().trim().min(1, "Give a reason for the correction").max(300),
});

/** 0132: Gerry sets master to the actual quantity; the RPC writes the delta as
 *  a `correction` movement. The RPC re-checks — this just phrases the refusal. */
export async function correctMasterStock(input: unknown): Promise<ActionResult> {
  if (!(await isPrimaryOwner())) {
    return { ok: false, error: "Only the owner can correct stock" };
  }
  const parsed = correctStockSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_correct_master_stock", {
    p_part_id: parsed.data.part_id,
    p_new_qty: parsed.data.new_qty,
    p_reason: parsed.data.reason,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/master-inventory");
  revalidatePath("/movements");
  revalidatePath("/stock-alerts");
  return { ok: true };
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Report for review. Do NOT commit.**

---

### Task 3: The dialog

**Files:**
- Create: `app/(owner)/master-inventory/correct-stock-dialog.tsx`

**Interfaces:**
- Consumes: `correctMasterStock` from Task 2.
- Produces: `CorrectStockDialog` and the exported type `CorrectablePart` (`{ id: string; name: string; unit: string; master_qty: number }`). Props: `part: CorrectablePart | null` (null = closed), `onOpenChange: (open: boolean) => void`, `fractional?: boolean`.

- [ ] **Step 1: Create the component**

```tsx
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { formatQty, parseQty, sanitizeQtyInput } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { correctMasterStock } from "./actions";

export interface CorrectablePart {
  id: string;
  name: string;
  unit: string;
  master_qty: number;
}

/** 0132: set master to the ACTUAL quantity. The delta is written as a
 *  `correction` movement, so the ledger keeps explaining the shelf. */
export function CorrectStockDialog({
  part,
  onOpenChange,
  fractional = false,
}: {
  part: CorrectablePart | null;
  onOpenChange: (open: boolean) => void;
  /** the product's unit allows tenths — see units.allows_fractional */
  fractional?: boolean;
}) {
  const router = useRouter();
  const [raw, setRaw] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (part) {
      setRaw(formatQty(part.master_qty));
      setReason("");
    }
  }, [part]);

  const parsed = parseQty(raw, { allowFractional: fractional, allowZero: true });
  const delta = parsed === null || !part ? null : parsed - part.master_qty;
  const canSave =
    !busy && parsed !== null && delta !== null && delta !== 0 && reason.trim() !== "";

  async function onSubmit() {
    if (!part || parsed === null) return;
    setBusy(true);
    const res = await correctMasterStock({
      part_id: part.id, new_qty: parsed, reason: reason.trim(),
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(`${part.name} corrected to ${formatQty(parsed)} ${part.unit}`);
    onOpenChange(false);
    router.refresh();
  }

  return (
    <Dialog open={!!part} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Correct stock</DialogTitle>
          <DialogDescription>
            Set master to what is actually there. This does not change any
            shop&apos;s stock, and it is not recorded as a loss.
          </DialogDescription>
        </DialogHeader>

        {part && (
          <div className="flex flex-col gap-4">
            <div className="text-sm">
              <div className="font-medium">{part.name}</div>
              <div className="text-muted-foreground">
                System says {formatQty(part.master_qty)} {part.unit}
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="actual-qty">Actual quantity</Label>
              <Input
                id="actual-qty"
                inputMode="decimal"
                value={raw}
                onChange={(e) => setRaw(sanitizeQtyInput(e.target.value))}
                aria-label="Actual quantity"
              />
              {parsed !== null && delta !== null && delta !== 0 && (
                <p className="text-xs text-muted-foreground">
                  {formatQty(part.master_qty)} → {formatQty(parsed)} {part.unit}
                  {" · "}
                  {delta > 0 ? "+" : ""}
                  {formatQty(delta)} {part.unit}
                </p>
              )}
              {delta === 0 && (
                <p className="text-xs text-muted-foreground">
                  That is already the recorded quantity.
                </p>
              )}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="correction-reason">Reason</Label>
              <Textarea
                id="correction-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. over-encoded at receiving"
                maxLength={300}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={!canSave}>
            {busy && <Loader2 className="size-4 animate-spin" />} Correct stock
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Report for review. Do NOT commit.**

---

### Task 4: Wire it into Master Inventory

**Files:**
- Modify: `app/(owner)/master-inventory/parts-table.tsx`
- Modify: `app/(owner)/master-inventory/page.tsx`

**Interfaces:**
- Consumes: `CorrectStockDialog` from Task 3.
- Produces: a `correctLocked?: boolean` prop on `PartsTable`, defaulting `false`, hiding the menu item when true.

- [ ] **Step 1: Add the import, prop and state to `parts-table.tsx`**

Add beside the other local dialog imports:

```ts
import { CorrectStockDialog } from "./correct-stock-dialog";
```

In the destructured props add `correctLocked = false,` beside `retireLocked = false,`. In the prop type block add:

```ts
  /** 0132: correcting master stock is Gerry-only — hidden for the admin. */
  correctLocked?: boolean;
```

Beside the other dialog state:

```ts
  const [correctingFor, setCorrectingFor] = React.useState<PartRow | null>(null);
```

Add `ClipboardCheck` to the existing `lucide-react` import.

- [ ] **Step 2: Add the menu item**

In the row dropdown, immediately BEFORE the `{!retireLocked && (` destructive block:

```tsx
          {!correctLocked && (
            <DropdownMenuItem onClick={() => setCorrectingFor(part)}>
              <ClipboardCheck className="size-4" /> Correct stock
            </DropdownMenuItem>
          )}
```

- [ ] **Step 3: Render the dialog**

Beside the other dialogs (near `<MergeDuplicatesDialog …>`):

```tsx
      <CorrectStockDialog
        part={
          correctingFor
            ? {
                id: correctingFor.id,
                name: correctingFor.name,
                unit: correctingFor.unit,
                master_qty: correctingFor.master_qty,
              }
            : null
        }
        onOpenChange={(open) => !open && setCorrectingFor(null)}
      />
```

`fractional` is deliberately left at its default `false` — this task does NOT add a units fetch. A whole-unit product is refused client-side, and a `kg` product is still refused by name at the database if a fraction slips through. Widening this is a separate change.

- [ ] **Step 4: Pass the flag from `page.tsx`**

At both call sites that already set `priceLocked` / `retireLocked` (around lines 152 and 219), add:

```tsx
      correctLocked={profile?.role === "admin"}
```

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint "app/(owner)/master-inventory"`
Expected: both exit 0.

- [ ] **Step 6: Report for review. Do NOT commit.**

---

### Task 5: Browser QA

**Files:**
- Create: `scripts/qa-browser/cs1-correct-stock.mjs`

**Interfaces:**
- Consumes: the running app (`npm run dev`) against staging, and `qa-lib.mjs` (`launch`, `login`, `goto`, `check`, `summary`, `shot`, `ok`, `dbAuth`).

- [ ] **Step 1: Seed a correctable product**

The script needs at least one part with master stock. Run
`node scripts/test-stock-correction.mjs` first only to confirm the RPC is live —
it cleans up after itself, so it leaves nothing to correct. Create a product
through Receiving in the UI, or use `node scripts/seed-more-stock.mjs`, and note
its name. Report which you used.

- [ ] **Step 2: Write the QA script**

```js
/**
 * QA 0132: Gerry corrects a master quantity from the UI; an admin cannot.
 *
 * Run: node scripts/qa-browser/cs1-correct-stock.mjs   (needs npm run dev)
 */
import { launch, login, goto, check, summary, shot, ok, dbAuth } from "./qa-lib.mjs";

const { browser, page } = await launch();

try {
  await login(page, "owner");
  await goto(page, "/master-inventory");

  const search = page.getByPlaceholder(/search/i).first();
  await search.fill("ZZ-TEST");
  await page.waitForTimeout(1200); // debounced server search

  const firstRow = page.locator("table tbody tr").first();
  check(await firstRow.isVisible().catch(() => false), "a product row is listed");

  const name = (await firstRow.locator("td").nth(0).innerText()).trim();
  ok(`correcting "${name}"`);

  await firstRow.getByRole("button", { name: /open menu|more/i }).click();
  const item = page.getByRole("menuitem", { name: /correct stock/i });
  check(await item.isVisible().catch(() => false), "owner sees 'Correct stock'");
  await item.click();

  const qty = page.getByLabel("Actual quantity");
  check(await qty.isVisible().catch(() => false), "the dialog opened");
  await qty.fill("3");
  await page.getByLabel("Reason").fill("QA correction");

  const save = page.getByRole("button", { name: /^correct stock$/i });
  check(await save.isEnabled(), "save enables once qty + reason are set");
  await save.click();
  await page.waitForTimeout(2500);
  await shot(page, "cs1-after-correct");

  // the database must agree with the screen
  const q = await dbAuth("owner");
  const rows = await q(`parts?select=id,name&name=eq.${encodeURIComponent(name)}`);
  const partId = rows?.[0]?.id;
  check(!!partId, "found the product in the database");
  if (partId) {
    const lvl = await q(`stock_levels?select=qty&part_id=eq.${partId}&shop_id=is.null`);
    check(Number(lvl?.[0]?.qty) === 3, `master is 3 in the DB (got ${lvl?.[0]?.qty})`);
    const mv = await q(
      `stock_movements?select=movement_type,qty_change&part_id=eq.${partId}&movement_type=eq.correction`
    );
    check((mv ?? []).length > 0, "a correction movement exists");
  }

  // admin must not see the control at all
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await login(page2, "admin");
  await goto(page2, "/master-inventory");
  await page2.getByPlaceholder(/search/i).first().fill("ZZ-TEST");
  await page2.waitForTimeout(1200);
  await page2
    .locator("table tbody tr")
    .first()
    .getByRole("button", { name: /open menu|more/i })
    .click();
  const adminItem = page2.getByRole("menuitem", { name: /correct stock/i });
  check(
    !(await adminItem.isVisible().catch(() => false)),
    "admin does NOT see 'Correct stock'"
  );
  await shot(page2, "cs1-admin-menu");
  await ctx2.close();
} finally {
  await browser.close();
}
summary();
```

- [ ] **Step 3: Run it**

Run `npm run dev` in one terminal, then `node scripts/qa-browser/cs1-correct-stock.mjs`.
Expected: every check passes. If `next dev` moved off port 3000, set `TEST_BASE_URL` — it moves silently and another project's server will answer happily.

- [ ] **Step 4: Report for review, with the screenshots. Do NOT commit.**

---

### Task 6: Documentation and full verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Correct the now-false statement in CLAUDE.md**

Under "The ledger has no transit location", `CLAUDE.md` currently says corrections
do not exist and warns against adding an edit path. That is no longer true and
will mislead. Replace that paragraph with:

```markdown
**Corrections are Gerry's alone (0132).** `movement_type`'s `correction` value
had zero rows and no writer until `fn_correct_master_stock`, which sets MASTER
stock for a PART to the actual quantity and writes the delta as a `correction`
movement. `is_primary_owner()` only — the admin who mis-encodes cannot erase it.
`lib/pnl.ts` ignores `correction`, so a fixed number never books as shrinkage;
that is the whole reason it is not a `loss`. Shop stock, engines and genuine
master shrinkage are all still out of reach — `losses.shop_id` is NOT NULL, so a
master loss cannot be represented at all. `stock_movements` still has no
INSERT/UPDATE/DELETE policy for anyone; the RPC is the only writer.
```

Also add `test-stock-correction` to the Suites list, `fn_correct_master_stock` to
the "Key backend functions" list, and append `· 0132` **owner stock correction**
to the migrations list.

- [ ] **Step 2: Full suite**

Run: `npm test`
Expected: every suite passes, including the new one. Note the total assertion count.

- [ ] **Step 3: Typecheck and lint the whole app**

Run: `npx tsc --noEmit && npx eslint app components lib`
Expected: `tsc` exit 0; eslint shows no NEW errors (`lib/shop-nav.ts` has 4 pre-existing).

- [ ] **Step 4: Report for review with `git diff --stat`. Do NOT commit.**

The user commits, pushes to staging, does manual QA, then promotes to production
and applies 0132 there.
