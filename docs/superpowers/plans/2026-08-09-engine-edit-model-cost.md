# Engine Edit — Model & Cost Unlock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the office edit an engine's cost (Gerry only) and model (reassign the serial to another model while in master, plus rename the model globally) from the Edit Engine dialog — fields that today are hardcoded `disabled` for everyone.

**Architecture:** Pure app-layer change — **no migration**. The DB already permits everything we enable: the 0100 `enforce_price_lock` trigger lets the primary owner change `engines.cost_centavos`/`price_centavos` (and refuses an admin), RLS grants office-tier UPDATE on `engines`, and nothing gates `engine_model_id`. We (1) extend the `updateEngine` server action with a model-reassignment guard + price>cost validation, (2) turn the dialog's dead Cost display into a real form field disabled only for admins (the exact pattern `part-form-dialog.tsx` already uses), (3) turn the dead Model display into a picker enabled only while `status === 'in_master'`, and (4) add an inline "Rename model" panel that calls the existing office-tier `updateEngineModel` action.

**Tech Stack:** Next.js 16 App Router server actions, react-hook-form + Zod, shadcn/ui, Supabase (PostgREST, RLS + BEFORE UPDATE triggers already in place).

## Root cause (for context)

- Cost input: hardcoded `disabled` at `app/(owner)/master-inventory/engine-form-dialog.tsx:219`; not a form field at all — submit echoes `engine.cost_centavos` back. This predates 0100 and is now inconsistent: the **parts** dialog lets Gerry edit cost (`disabled={priceLocked}`).
- Model input: hardcoded `disabled` at `engine-form-dialog.tsx:193` ("fixed at receiving"). Rename exists only behind the Models toolbar button.
- The server action `updateEngine` (`app/(owner)/master-inventory/actions.ts:368`) **already** passes `cost_centavos` through for the owner and strips it for an admin. Only the dialog never exposed the field.

## Global Constraints

- **NEVER commit or push** — the user handles all git commits themselves. No `git commit` steps appear in this plan; each task ends at "verify", after which the user commits.
- **No new migration.** DB behavior is already correct (0100 trigger, office-tier `engines` UPDATE RLS). If you find yourself writing SQL, stop — you've misread the plan.
- **0100 stands:** an admin must never be able to change `cost_centavos` or `price_centavos` after entry. UI disables; the server action strips; the DB trigger is the real gate.
- **Model reassignment is office-tier** (owner + admin — it's a catalog correction like a part rename, not a money/evidence action) but only while `engines.status = 'in_master'`. Once a unit is delivered/sold it is history.
- **Model rename is office-tier** via the existing `updateEngineModel` action (unchanged) and renames every engine of that model — the UI must say so.
- Code comments: minimal, one line max (project convention).
- This is NOT the Next.js you know — if touching anything beyond what this plan specifies, read `node_modules/next/dist/docs/` first.
- Test harness rules apply if you touch `scripts/`: never hardcode shop UUIDs, `.env.local` must declare `SUPABASE_ENV=staging`.

## File Structure

- Modify: `app/(owner)/master-inventory/actions.ts` — `engineEditSchema` + `updateEngine` (lines 360–385): add `engine_model_id`, in-master guard, price>cost check.
- Modify: `app/(owner)/master-inventory/engine-form-dialog.tsx` — cost form field, model Select, rename panel, submit wiring.
- No other files change. `engines-table.tsx` already passes `models` and `priceLocked` to the dialog; `page.tsx` already fetches `engine_models` with `is_serialized, sku`; `EngineModel`/`EngineRow` types in `lib/db-types.ts` already carry every field used below.

---

### Task 1: `updateEngine` server action — model guard + money validation

**Files:**
- Modify: `app/(owner)/master-inventory/actions.ts:360-385`

**Interfaces:**
- Consumes: existing `getProfile()` from `@/lib/auth`, `createClient()` from `@/lib/supabase/server`.
- Produces: `updateEngine(input)` now REQUIRES `engine_model_id: string (uuid)` in its payload. Task 3's dialog submit depends on this exact shape:
  `{ id, engine_model_id, condition, cost_centavos, price_centavos, warranty_months }`.

- [ ] **Step 1: Replace the schema and function**

Replace the current block (from `const engineEditSchema` through the end of `updateEngine`) with:

```ts
const engineEditSchema = z.object({
  id: z.uuid(),
  engine_model_id: z.uuid(),
  condition: z.enum(["brand_new", "second_hand"]),
  cost_centavos: z.number().int().min(0),
  price_centavos: z.number().int().min(0),
  warranty_months: z.number().int().min(0).nullable(),
});

export async function updateEngine(input: unknown): Promise<ActionResult> {
  const parsed = engineEditSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, engine_model_id, cost_centavos, price_centavos, ...rest } = parsed.data;
  // 0100: same rule as parts — an admin's edit never touches the money columns
  const profile = await getProfile();
  const supabase = await createClient();

  // model reassignment fixes a wrong-model receiving — master-only, units that
  // left are history
  const { data: current } = await supabase
    .from("engines")
    .select("engine_model_id, status")
    .eq("id", id)
    .single();
  if (!current) return { ok: false, error: "Engine not found" };
  const modelChanged = current.engine_model_id !== engine_model_id;
  if (modelChanged && current.status !== "in_master") {
    return { ok: false, error: "Model can only be changed while the engine is in master stock" };
  }

  if (profile?.role !== "admin" && price_centavos <= cost_centavos) {
    return { ok: false, error: "Selling price must be above cost" };
  }

  const fields = {
    ...rest,
    ...(modelChanged ? { engine_model_id } : {}),
    ...(profile?.role === "admin" ? {} : { cost_centavos, price_centavos }),
  };
  const { error } = await supabase.from("engines").update(fields).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/master-inventory");
  return { ok: true };
}
```

- [ ] **Step 2: Typecheck — expect exactly one downstream failure**

Run: `npx tsc --noEmit`
Expected: ONE error, in `engine-form-dialog.tsx` — `updateEngine` is now called without `engine_model_id`. That error is Task 3's job; anything else failing means Step 1 went wrong. (`tsc` won't flag the extra-property absence through `input: unknown` — if it compiles clean, that's also acceptable; the dialog change in Task 3 is still required for runtime correctness.)

- [ ] **Step 3: Hand off** — do NOT commit (user commits). Note in the task report that the dialog is intentionally broken/stale until Task 3.

---

### Task 2: Dialog — unlock the Cost field for Gerry

**Files:**
- Modify: `app/(owner)/master-inventory/engine-form-dialog.tsx`

**Interfaces:**
- Consumes: `priceLocked` prop (already passed: `true` for admin, `false` for Gerry — `page.tsx:222` → `engines-table.tsx:372`).
- Produces: form field `cost` (peso string) that Task 3's submit parses into `cost_centavos`.

- [ ] **Step 1: Add `cost` to the form schema**

```ts
const formSchema = z.object({
  condition: z.enum(["brand_new", "second_hand"]),
  cost: pesoField,
  price: pesoField,
  warranty_months: z.string(), // "" = model default
});
```

- [ ] **Step 2: Update defaults and reset**

In `useForm` `defaultValues` add `cost: "0"`. In the `React.useEffect` reset block add:

```ts
      reset({
        condition: engine.condition,
        cost: (engine.cost_centavos / 100).toFixed(2),
        price: (engine.price_centavos / 100).toFixed(2),
        warranty_months: engine.warranty_months?.toString() ?? "",
      });
```

- [ ] **Step 3: Make the below-cost floor track the EDITED cost**

Replace the `costC` line:

```ts
  // Selling price must clear cost — floor moves live if Gerry edits the cost.
  const costC = parsePesosToCentavos(watch("cost")) ?? engine?.cost_centavos ?? 0;
```

(For an admin the disabled input still holds the reset value, so `watch("cost")` stays the true cost.)

- [ ] **Step 4: Replace the dead Cost display with a form field**

Replace:

```tsx
            <div className="grid gap-2">
              <Label>Cost ₱ (owner-only)</Label>
              <Input value={formatCentavos(costC)} disabled aria-label="Cost (set at receiving)" />
            </div>
```

with:

```tsx
            <div className="grid gap-2">
              <Label htmlFor="engine-cost">Cost ₱ (owner-only)</Label>
              <Input id="engine-cost" inputMode="decimal" disabled={priceLocked} {...register("cost")} />
              {errors.cost && (
                <p className="text-sm text-destructive">{errors.cost.message}</p>
              )}
            </div>
```

- [ ] **Step 5: Update the admin hint copy under Selling price**

Replace `Only the owner can change the selling price.` with `Only the owner can change cost or selling price.` (matches the 0100 trigger message).

- [ ] **Step 6: Wire cost into submit** (temporary until Task 3 finishes the payload)

In `onSubmit`, replace the price-floor block and the `updateEngine` call's cost line:

```ts
    const cost_centavos = priceLocked
      ? engine.cost_centavos
      : parsePesosToCentavos(values.cost)!;
    const price_centavos = parsePesosToCentavos(values.price)!;
    if (price_centavos <= cost_centavos) {
      toast.error(`Selling price must be above cost ${formatCentavos(cost_centavos)}`);
      return;
    }
```

and pass `cost_centavos` (the new local) in the `updateEngine` payload.

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit` — expected: only the missing `engine_model_id` complaint remains, if tsc surfaces it at all (Task 3 resolves it).
Also update the stale comment on the `priceLocked` prop (`0100: the selling price is Gerry-only after entry (cost is already fixed).` → `/** 0100: cost + selling price are Gerry-only after entry. */`).

- [ ] **Step 8: Hand off** — no commit.

---

### Task 3: Dialog — Model picker (reassign while in master)

**Files:**
- Modify: `app/(owner)/master-inventory/engine-form-dialog.tsx`

**Interfaces:**
- Consumes: `updateEngine` payload from Task 1 (`engine_model_id` required); `models: EngineModel[]` prop (already passed); `EngineRow.status`, `.brand`, `.model`, `.engine_model_id`.
- Produces: form field `engine_model_id` (uuid string). Task 4 reads the selected id via `watch("engine_model_id")`.

- [ ] **Step 1: Add `engine_model_id` to the form schema**

```ts
const formSchema = z.object({
  engine_model_id: z.string().min(1, "Pick a model"),
  condition: z.enum(["brand_new", "second_hand"]),
  cost: pesoField,
  price: pesoField,
  warranty_months: z.string(), // "" = model default
});
```

Add `engine_model_id: ""` to `defaultValues` and `engine_model_id: engine.engine_model_id` to the reset block.

- [ ] **Step 2: Derive picker state near the other watches**

```ts
  const modelValue = watch("engine_model_id");
  // reassignment fixes a wrong-model receiving; units that left master are history
  const inMaster = engine?.status === "in_master";
  const selectedModel = models.find((m) => m.id === modelValue);
```

- [ ] **Step 3: Replace the dead Model display**

Replace the whole `<div className="grid min-w-0 gap-2">` Model block (the one containing the triple `models.find(...)` Input) with:

```tsx
            <div className="grid min-w-0 gap-2">
              <Label>Model</Label>
              {inMaster ? (
                <Select
                  value={modelValue}
                  onValueChange={(v) => setValue("engine_model_id", v, { shouldValidate: true })}
                >
                  <SelectTrigger className="w-full" aria-label="Engine model">
                    <SelectValue placeholder="Pick a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {/* engine's own model may be retired — keep it selectable */}
                    {!selectedModel && engine && (
                      <SelectItem value={engine.engine_model_id}>
                        {engine.brand} {engine.model} (retired)
                      </SelectItem>
                    )}
                    {models.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.brand} {m.model}
                        {m.horsepower != null ? ` — ${m.horsepower}HP` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={selectedModel ? `${selectedModel.brand} ${selectedModel.model}` : engine ? `${engine.brand} ${engine.model}` : "—"}
                  disabled
                  aria-label="Engine model (fixed once the engine has left master)"
                />
              )}
            </div>
```

- [ ] **Step 4: Send the model on submit**

In the `updateEngine` payload add `engine_model_id: values.engine_model_id,`. Full call after Tasks 1–3:

```ts
    const res = await updateEngine({
      id: engine.id,
      engine_model_id: values.engine_model_id,
      condition: values.condition,
      cost_centavos,
      warranty_months: warranty,
      price_centavos,
    });
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit` — expected: clean.
Run: `npm run lint` — expected: clean for the two touched files.

- [ ] **Step 6: Hand off** — no commit.

---

### Task 4: Dialog — inline "Rename model" panel

**Files:**
- Modify: `app/(owner)/master-inventory/engine-form-dialog.tsx`

**Interfaces:**
- Consumes: existing office-tier action `updateEngineModel(input)` from `./actions` — full payload required: `{ id, brand, model, horsepower, stroke, default_warranty_months, is_serialized, sku }` (schema at `actions.ts:525`). Selected model id via `watch("engine_model_id")` (Task 3).
- Produces: nothing consumed downstream; `revalidatePath` inside the action refreshes the `models` prop.

- [ ] **Step 1: Imports**

Add `Pencil` to the `lucide-react` import and `updateEngineModel` to the `./actions` import.

- [ ] **Step 2: Rename state + handlers** (inside the component, near the image state)

```ts
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [renameBrand, setRenameBrand] = React.useState("");
  const [renameName, setRenameName] = React.useState("");
  const [renameBusy, setRenameBusy] = React.useState(false);

  function openRename() {
    const m = models.find((x) => x.id === watch("engine_model_id"));
    setRenameBrand(m?.brand ?? engine?.brand ?? "");
    setRenameName(m?.model ?? engine?.model ?? "");
    setRenameOpen(true);
  }

  async function saveRename() {
    const m = models.find((x) => x.id === watch("engine_model_id"));
    if (!m) {
      toast.error("This model is retired — restore it from the Models dialog first");
      return;
    }
    if (!renameBrand.trim() || !renameName.trim()) {
      toast.error("Brand and model are required");
      return;
    }
    setRenameBusy(true);
    const res = await updateEngineModel({
      id: m.id,
      brand: renameBrand.trim(),
      model: renameName.trim(),
      horsepower: m.horsepower,
      stroke: (m.stroke as "2-stroke" | "4-stroke" | null) ?? null,
      default_warranty_months: m.default_warranty_months ?? 12,
      is_serialized: m.is_serialized ?? true,
      sku: m.sku ?? null,
    });
    setRenameBusy(false);
    if (res.ok) {
      toast.success(`Model renamed to ${renameBrand.trim()} ${renameName.trim()}`);
      setRenameOpen(false);
    } else toast.error(res.error);
  }
```

Also reset the panel when the dialog opens — add `setRenameOpen(false);` next to `setImageAction({ type: "keep" });` in the open-effect.

- [ ] **Step 3: Rename affordance on the Model label**

In Task 3's Model block, replace the bare `<Label>Model</Label>` with:

```tsx
              <div className="flex items-center justify-between gap-2">
                <Label>Model</Label>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
                  onClick={openRename}
                >
                  <Pencil className="size-3" /> Rename model
                </button>
              </div>
```

- [ ] **Step 4: The panel itself** — directly AFTER the two-column model/condition grid `</div>`, add:

```tsx
          {renameOpen && (
            <div className="grid gap-2 rounded-md border p-3">
              <p className="text-xs text-muted-foreground">
                Renames the model everywhere — every engine of this model, past and present.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Input value={renameBrand} onChange={(e) => setRenameBrand(e.target.value)} placeholder="Brand" aria-label="Brand" />
                <Input value={renameName} onChange={(e) => setRenameName(e.target.value)} placeholder="Model" aria-label="Model name" />
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setRenameOpen(false)}>
                  Cancel
                </Button>
                <Button type="button" size="sm" disabled={renameBusy} onClick={saveRename}>
                  {renameBusy && <Loader2 className="size-4 animate-spin" />} Rename
                </Button>
              </div>
            </div>
          )}
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit` and `npm run lint` — expected: clean.

- [ ] **Step 6: Hand off** — no commit.

---

### Task 5: Verification pass (no new suite — here's why)

No DB behavior changed, so no new migration-gated `.mjs` suite: `scripts/test-price-lock.mjs` already proves at the PostgREST level that the owner CAN and an admin CANNOT write `engines.cost_centavos`/`price_centavos` (its gate is the 0100 trigger itself). The in-master model guard lives in a server action, which the script harness cannot invoke — it is a UX guard, not a security boundary (RLS intentionally allows office-tier `engine_model_id` writes), so manual QA is the correct check.

- [ ] **Step 1: Static checks**

Run: `npx tsc --noEmit` then `npm run lint`
Expected: both clean.

- [ ] **Step 2: Existing DB coverage still green**

Run: `npm test -- --only=price-lock`
Expected: PASS (unchanged suite; proves the trigger contract this feature leans on). Requires `.env.local` with `SUPABASE_ENV=staging`.

- [ ] **Step 3: Manual QA — as Gerry (owner login) against `npm run dev`**

1. Master Inventory → Engines → Edit an **in_master** engine: Model is a dropdown, Cost is editable, Selling price editable.
2. Change cost to a value above the current price → Save blocked ("Selling price must be above cost").
3. Change cost down, save → toast "Engine updated"; card/table shows the new cost.
4. Reassign the engine to another model, save → the row shows the new model; Movements/serial unchanged.
5. Edit a **delivered or sold** engine: Model renders as a disabled input; cost still editable; save works.
6. "Rename model" → change the model text, Rename → every engine of that model shows the new name (check a second serial of the same model).

- [ ] **Step 4: Manual QA — as an admin login**

1. Edit any engine: Cost AND Selling price disabled, hint reads "Only the owner can change cost or selling price."
2. Model dropdown works on an in_master engine (reassignment is office-tier); save succeeds.
3. Rename model works (office-tier, per `updateEngineModel`).
4. Sanity (defense in depth): if you force a cost write as admin via devtools/PostgREST, the DB refuses with "Only the owner can change cost or selling price" — that's 0100, not this change.

- [ ] **Step 5: Report results to the user with any failures verbatim. Do not commit — the user commits.**

---

## Self-review notes

- **Spec coverage:** cost unlock (Task 2), model reassign (Tasks 1+3), model rename (Task 4) — the "Both" decision — all covered; admin lock preserved everywhere (Tasks 1/2 + existing trigger).
- **Type consistency:** `updateEngine` payload shape defined in Task 1 matches Task 3 Step 4 call; `cost` peso-string field defined in Task 2 is what Task 2 Step 6 parses; `updateEngineModel` payload matches `modelEditSchema` (`actions.ts:525-534`) field-for-field.
- **Known edge decisions:** retired model stays selectable as "(retired)" so an untouched save never errors; admin's disabled cost input still submits the true value via RHF state (and the action strips it anyway); `modelChanged` computed server-side against the DB row, not the client's claim.
