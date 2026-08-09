# Non-serialized engine models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the office receive N units of an engine model that has no per-unit serial — one shared product code instead — without weakening serial tracking for the models that do have plates.

**Architecture:** Serialization becomes a property of the **model**, not of every unit: `engine_models.is_serialized`. This is the `units.allows_fractional` pattern from 0114 — the rule lives on the reference data because that is how a shopkeeper already thinks. A serialized model behaves exactly as today, one typed plate per unit. A non-serialized model accepts a quantity on a receiving line and gets that many unit rows, each identified by a system-minted `UNIT-########`, with the shared code recorded once on the model as `sku`. Engines remain **one row per physical unit** throughout — that is what keeps warranties (one per unit, enforced by a unique constraint), chain of custody, and the five `qty = 1` constraints intact.

**Tech Stack:** Postgres (Supabase) migrations + `SECURITY DEFINER` RPCs, Next.js 16 App Router server actions, React 19 client components, `scripts/test-*.mjs` harness suites.

## Global Constraints

- Migrations are **new files only**, numbered `0128`+. Never edit an applied migration — the CLI tracks by version, so an edited file is silently skipped where it already ran (`docs/DEPLOYMENT.md` §3).
- `db push` wraps each migration **file** in one transaction. Neither task adds an enum value, so the 0099 trap does not apply.
- `engines` has **no INSERT grant** for app roles (0049). Creation happens only inside `fn_receive_stock`. Do not add an INSERT path; test fixtures seed via the service role.
- **Every engine row is exactly one physical unit.** Do not touch the five `check (engine_id is null or qty = 1)` constraints or any `if p_qty <> 1` guard. A quantity of 5 means five rows.
- `engines.serial_number` stays `not null unique`. 146 app sites read it and assume a non-null string.
- `is_serialized` defaults **true**, so all 30 existing models keep today's behaviour and no data pass is needed. Gerry switches the rare exceptions.
- Engine quantities are whole numbers — an engine line's `qty` is an `int`, never `numeric`. Half an outboard does not exist.
- Comment style: minimal, one line where the reason is not obvious. Detail belongs in the migration header.
- `SUPABASE_ENV=staging` must be in `.env.local` for any test run; `scripts/_env-guard.mjs` enforces it.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/0128_engine_model_serialization.sql` | `is_serialized`, `sku`, the `UNIT-` sequence and `fn_generate_engine_unit_no()`. Additive; changes no behaviour on its own. |
| `supabase/migrations/0129_receive_engine_qty.sql` | `fn_receive_stock` engine arm accepts `qty`, allowed only on a non-serialized model. |
| `scripts/test-engine-nonserial.mjs` | The suite. Proves bulk create, refusal on a serialized model, and that a typed-serial receiving is unchanged. |
| `app/(owner)/suppliers/receiving-view.tsx` | Engine line gains a Qty box, enabled only for a non-serialized model. |
| `app/(owner)/suppliers/actions.ts` | Engine line schema gains `qty`; `serial_number` becomes optional. |
| `app/(owner)/master-inventory/reference-data-dialogs.tsx` | The model editor gains the "units have serial numbers" toggle and the code field. |
| `app/(owner)/master-inventory/actions.ts` | The engine-model upsert carries `is_serialized` and `sku`. |
| `CLAUDE.md` | Schema + migration notes. |

---

### Task 1: Serialization as a model property (migration 0128)

**Files:**
- Create: `supabase/migrations/0128_engine_model_serialization.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `public.engine_models.is_serialized boolean not null default true` · `public.engine_models.sku text` · `public.fn_generate_engine_unit_no() returns text` · sequence `public.engine_unit_seq`.

- [ ] **Step 1: Write the migration**

```sql
-- ---------------------------------------------------------------------------
-- 0128 — some engine models have no serial numbers.
--
-- Gerry buys five identical small engines that carry ONE product code between
-- them and no per-unit plate. Today every engine must have its own unique
-- serial, so he could add one and then the system refused the rest — he was
-- typing the shared code into the serial box because it was the only way to get
-- a second unit in.
--
-- WHERE THE RULE LIVES, and why: on the MODEL, not on each unit. This is
-- 0114's `units.allows_fractional` decision again — kilograms may be split and
-- pieces may not, so the rule belongs on the unit rather than as a flag someone
-- must remember on every product. Same here: a Yamaha 40HP has plates and a
-- cheap brush cutter does not, and that is a fact about the MODEL. Choosing it
-- once when the model is created is the whole action.
--
-- WHAT DOES NOT CHANGE: engines are still one row per physical unit. Five units
-- are five `engines` rows. That is what keeps warranties working — one per
-- engine, enforced by a unique constraint on `warranties.engine_id` — along
-- with the chain of custody on /movements?tab=engines and the five
-- `check (engine_id is null or qty = 1)` constraints. Nothing about quantity
-- reaches the engine tables.
--
-- `is_serialized` DEFAULTS TRUE so all 30 existing models keep today's exact
-- behaviour and there is no data pass. Gerry switches the rare exceptions.
--
-- `sku` mirrors `parts.sku` deliberately — same concept, same word, so nobody
-- has to learn two names for a product code. Not unique, exactly like
-- `parts.sku`, because the live data is the authority on whether codes repeat
-- and a hard constraint here would reject rows Gerry already has. Searchable,
-- not scannable: it is his own reference rather than a barcode on the box. If
-- that changes, `parts` keeps scannable codes in a separate `barcode` column,
-- so the door is open without a redesign.
--
-- `UNIT-########` is what fills `serial_number` for a unit that has no serial.
-- The column is `not null unique` and 146 app sites read it as a string, so a
-- minted value keeps every one of them correct — a nullable column would turn
-- each into its own "what shows when empty?" decision. The prefix reads as a
-- system number rather than a plausible plate, which is the point: nobody
-- should mistake it for something stamped on metal.
--
-- Additive and behaviour-free on its own. Nothing calls the function yet.
-- Safe to apply while the shops are open.
-- ---------------------------------------------------------------------------

alter table public.engine_models
  add column if not exists is_serialized boolean not null default true;

alter table public.engine_models
  add column if not exists sku text;

comment on column public.engine_models.is_serialized is
  'False when this model''s units carry no individual plate — they share the '
  'model''s sku and are interchangeable. Drives whether a receiving line may '
  'carry a quantity (0129). Defaults true: most engines are serialized.';

comment on column public.engine_models.sku is
  'The shared product code for a model. Mirrors parts.sku — same concept, and '
  'like parts.sku it is NOT unique. Searchable, not scanned.';

-- The office searches models by code; the catalog is small so this is cheap.
create index if not exists idx_engine_models_sku
  on public.engine_models (sku)
  where sku is not null;

create sequence if not exists public.engine_unit_seq;

create or replace function public.fn_generate_engine_unit_no()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  if not public.is_owner() then
    raise exception 'Only the office can number engine units';
  end if;

  -- Loop because a human could conceivably have typed a UNIT- serial by hand.
  loop
    v_code := 'UNIT-' || lpad(nextval('engine_unit_seq')::text, 8, '0');
    exit when not exists (select 1 from engines where serial_number = v_code);
  end loop;

  return v_code;
end $$;

revoke all on function public.fn_generate_engine_unit_no() from public, anon;
grant execute on function public.fn_generate_engine_unit_no() to authenticated;
```

- [ ] **Step 2: Apply to staging and verify**

Paste the file into the **staging** SQL editor (staging's `schema_migrations` is
empty — everything there is hand-applied; `docs/DEPLOYMENT.md` §3).

Run:
```sql
select column_name, data_type, column_default, is_nullable
from information_schema.columns
where table_schema='public' and table_name='engine_models'
  and column_name in ('is_serialized','sku') order by column_name;

select count(*) as models, count(*) filter (where is_serialized) as serialized
from public.engine_models where deleted_at is null;
```
Expected: `is_serialized boolean / true / NO`, `sku text / null / YES`; and
**every** existing model serialized.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0128_engine_model_serialization.sql
git commit -m "feat(db): 0128 — serialization is a property of the engine model

Gerry has engine models whose units carry one shared code and no per-unit plate.
He was typing that code into the serial box because it was the only way to add a
second unit, and engines.serial_number is unique.

is_serialized lives on the MODEL, not the unit — the units.allows_fractional
decision from 0114. A Yamaha 40HP has plates, a cheap brush cutter does not, and
that is a fact about the model. Defaults true so all 30 existing models are
untouched.

sku mirrors parts.sku (same concept, same word, also not unique). Searchable,
not scanned. UNIT-######## fills serial_number for a unit with no plate: the
column is not null unique and 146 app sites read it as a string.

Engines stay one row per physical unit. Warranties, chain of custody and the
five qty=1 constraints are untouched."
```

---

### Task 2: Receiving accepts a quantity for a non-serialized model (migration 0129)

**Files:**
- Create: `supabase/migrations/0129_receive_engine_qty.sql`
- Create: `scripts/test-engine-nonserial.mjs`

**Interfaces:**
- Consumes: `is_serialized`, `fn_generate_engine_unit_no()` (Task 1).
- Produces: `fn_receive_stock` engine lines accept an optional `qty int` (default 1). The function signature is unchanged — `p_engines` is `jsonb`, so this is a payload change, not an argument change. `new_model` gains optional `is_serialized` and `sku` keys.

**Context the implementer needs:** the engine arm to change is
`supabase/migrations/0118_fractional_qty_stock.sql:241-316`. Copy
`fn_receive_stock` whole into the new file and change **only** the engine loop.
The parts arm, the payment/credit-limit/override logic and the supplier-less
path (0059) must come across byte-for-byte — 0118's header explains why each is
the way it is; do not re-derive it.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-engine-nonserial.mjs`:

```js
/**
 * 0128–0129 — engine models with no per-unit serial.
 *
 * Gerry buys five identical small engines that share one product code and have
 * no plates. Serialization is a property of the MODEL (0114's
 * units.allows_fractional pattern), so a non-serialized model's receiving line
 * may carry a quantity and the units are numbered UNIT-########.
 *
 * Engines stay ONE ROW PER UNIT — five units are five rows, five
 * receiving_lines at qty 1, and five +1 ledger rows. Warranties and the five
 * qty=1 constraints are untouched, and this suite proves it.
 *
 * Provisions its own fixtures; never touches a real branch.
 */
import {
  owner, admin, check, section, summary, cleanup,
  seedSupplier, seedEngineModel, trackEngine, RUN,
} from "./_harness.mjs";

// gate: 0128 must be applied
{
  const { error } = await owner
    .from("engine_models").select("is_serialized").limit(1);
  if (error) {
    console.error(
      "test-engine-nonserial: 0128_engine_model_serialization.sql is not applied — apply 0128–0129 first."
    );
    process.exit(2);
  }
}

const supplier = await seedSupplier({ label: "EngineVendor" });

// a model with no plates, and a normal serialized one as the control
const loose = await seedEngineModel({ brand: "ZZ-TEST Hon", model: "GX35" });
await admin.from("engine_models")
  .update({ is_serialized: false, sku: `ZZ-CODE-${RUN}` }).eq("id", loose.id);
const plated = await seedEngineModel({ brand: "ZZ-TEST Yam", model: "F40" });

section("A non-serialized model takes a quantity");
{
  const { data: rcvId, error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST loose ${RUN}`,
    p_parts: [],
    p_engines: [{
      engine_model_id: loose.id, qty: 5,
      cost_centavos: 500000, price_centavos: 650000,
    }],
    p_payment_status: "unpaid",
    p_amount_paid: 0,
  });
  check("receiving 5 units succeeds", !error && !!rcvId, error?.message);

  const { data: units } = await owner
    .from("engines")
    .select("id, serial_number, status, cost_centavos")
    .eq("engine_model_id", loose.id);
  (units ?? []).forEach((u) => trackEngine(u.id));

  check("five engine ROWS exist, not one row of five",
    units?.length === 5, String(units?.length));
  check("every unit is in_master",
    (units ?? []).every((u) => u.status === "in_master"));
  check("every unit carries the line's cost",
    (units ?? []).every((u) => u.cost_centavos === 500000));

  const nos = (units ?? []).map((u) => u.serial_number);
  check("each is numbered UNIT-########",
    nos.every((s) => /^UNIT-\d{8}$/.test(s)), JSON.stringify(nos));
  check("the five numbers are DISTINCT",
    new Set(nos).size === 5, JSON.stringify(nos));

  // the engine qty=1 CHECK is untouched: one line per unit
  const { data: lines } = await owner
    .from("receiving_lines").select("engine_id, qty").eq("receiving_id", rcvId);
  check("five receiving lines, each qty 1",
    lines?.length === 5 && lines.every((l) => Number(l.qty) === 1),
    JSON.stringify(lines?.map((l) => l.qty)));

  const ids = (units ?? []).map((u) => u.id);
  const { data: movs } = await owner
    .from("stock_movements").select("engine_id, qty_change").in("engine_id", ids);
  check("five 'received' movements of +1",
    movs?.length === 5 && movs.every((m) => Number(m.qty_change) === 1),
    JSON.stringify(movs?.map((m) => m.qty_change)));
}

section("A serialized model still refuses a quantity");
{
  const { error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST plated qty ${RUN}`,
    p_parts: [],
    p_engines: [{
      engine_model_id: plated.id, qty: 3,
      cost_centavos: 900000, price_centavos: 1200000,
    }],
    p_payment_status: "unpaid",
    p_amount_paid: 0,
  });
  check("qty>1 on a serialized model is refused",
    /serial/i.test(error?.message ?? ""), error?.message ?? "it was ACCEPTED");
  check("the refusal names the model so the office knows which",
    /ZZ-TEST Yam|F40/.test(error?.message ?? ""), error?.message);
}

section("A serialized model still needs a serial per unit");
{
  const serial = `ZZ-TEST-SN-${RUN}`;
  const { error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST plated ${RUN}`,
    p_parts: [],
    p_engines: [{
      engine_model_id: plated.id, serial_number: serial,
      cost_centavos: 900000, price_centavos: 1200000,
    }],
    p_payment_status: "unpaid",
    p_amount_paid: 0,
  });
  check("a typed-serial receiving still works", !error, error?.message);

  const { data: u } = await owner
    .from("engines").select("id, serial_number").eq("serial_number", serial).maybeSingle();
  trackEngine(u?.id);
  check("the typed serial is stored verbatim", u?.serial_number === serial);

  const missing = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST plated blank ${RUN}`,
    p_parts: [],
    p_engines: [{ engine_model_id: plated.id, cost_centavos: 1, price_centavos: 2 }],
    p_payment_status: "unpaid",
    p_amount_paid: 0,
  });
  check("a serialized model with NO serial is refused",
    /serial/i.test(missing.error?.message ?? ""),
    missing.error?.message ?? "it was ACCEPTED");
}

section("A serial and a quantity together are refused");
{
  const { error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST both ${RUN}`,
    p_parts: [],
    p_engines: [{
      engine_model_id: loose.id, serial_number: `ZZ-TEST-X-${RUN}`, qty: 3,
      cost_centavos: 1000, price_centavos: 2000,
    }],
    p_payment_status: "unpaid",
    p_amount_paid: 0,
  });
  check("serial + qty>1 is refused",
    /one serial|cannot describe/i.test(error?.message ?? ""),
    error?.message ?? "it was ACCEPTED");
}

section("A quantity below 1 is refused");
{
  const { error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST zero ${RUN}`,
    p_parts: [],
    p_engines: [{ engine_model_id: loose.id, qty: 0, cost_centavos: 1000, price_centavos: 2000 }],
    p_payment_status: "unpaid",
    p_amount_paid: 0,
  });
  check("qty 0 is refused",
    /at least one|must be|positive/i.test(error?.message ?? ""),
    error?.message ?? "it was ACCEPTED");
}

section("An inline new model can be created non-serialized");
{
  const code = `ZZ-INLINE-${RUN}`;
  const { error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST inline ${RUN}`,
    p_parts: [],
    p_engines: [{
      qty: 2, cost_centavos: 300000, price_centavos: 400000,
      new_model: {
        brand: "ZZ-TEST Inline", model: `NS-${RUN}`,
        is_serialized: false, sku: code, default_warranty_months: 6,
      },
    }],
    p_payment_status: "unpaid",
    p_amount_paid: 0,
  });
  check("an inline non-serialized model + 2 units succeeds", !error, error?.message);

  const { data: m } = await owner
    .from("engine_models").select("id, is_serialized, sku")
    .eq("model", `NS-${RUN}`).maybeSingle();
  check("the model was created non-serialized", m?.is_serialized === false);
  check("and carries the shared code", m?.sku === code, m?.sku);

  const { data: units } = await owner
    .from("engines").select("id").eq("engine_model_id", m.id);
  (units ?? []).forEach((u) => trackEngine(u.id));
  check("two units were created", units?.length === 2, String(units?.length));
}

section("A non-serialized unit sells and warrants like any other");
{
  const { provisionShop, deliverAndConfirm } = await import("./_harness.mjs");
  const shop = await provisionShop("NonSerial");

  const { data: avail } = await owner
    .from("engines").select("id").eq("engine_model_id", loose.id)
    .eq("status", "in_master").limit(1);
  const unit = avail[0].id;

  await deliverAndConfirm(shop, { engine_ids: [unit] });

  const sale = await shop.client.rpc("fn_record_sale", {
    p_customer_id: null,
    p_customer: { name: `ZZ-TEST Buyer ${RUN}` },
    p_part_lines: [],
    p_engine_lines: [{ engine_id: unit }],
    p_payment_type: "full",
    p_amount_paid_centavos: null,
    p_payment_method: "cash",
  });
  check("a non-serialized unit records as a sale", !sale.error && !!sale.data,
    sale.error?.message);

  const appr = await owner.rpc("fn_approve_sale", { p_sale_id: sale.data, p_note: null });
  check("it approves", !appr.error, appr.error?.message);

  const { data: w } = await owner
    .from("warranties").select("id, engine_id").eq("engine_id", unit).maybeSingle();
  check("a warranty was created for THAT unit", !!w,
    "one row per unit is what makes this possible");
}

await cleanup();
summary();
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node scripts/test-engine-nonserial.mjs`
Expected: the first section FAILS — `fn_receive_stock` ignores `qty` today and
raises `Engine line missing serial_number`.

- [ ] **Step 3: Write the migration**

```sql
-- ---------------------------------------------------------------------------
-- 0129 — a receiving engine line may carry a QUANTITY, for a model whose units
--        have no serial numbers.
--
-- `{engine_model_id, qty: 5}` on a NON-serialized model creates five engine
-- rows, each numbered UNIT-######## (0128). On a serialized model it is
-- REFUSED: if the units have plates, each plate matters and each is typed. That
-- refusal is the feature, not a limitation — it is what stops a real serial
-- being replaced by a system number by accident.
--
-- Engines are still one row per unit. Five units are five `engines` rows, five
-- `receiving_lines` at qty 1 and five `+1` ledger rows, so the five
-- `check (engine_id is null or qty = 1)` constraints and every `p_qty <> 1`
-- guard are untouched, and warranties stay one per unit. Nothing downstream can
-- tell a bulk-created unit from a typed one except its serial format.
--
-- Serial AND qty>1 together is refused rather than reconciled: one code cannot
-- describe five engines, and quietly applying it to the first would be the kind
-- of silent wrong answer this codebase keeps refusing to ship.
--
-- `new_model` gains optional `is_serialized` and `sku`, so the office can
-- create a non-serialized model inline on the receiving that first stocks it —
-- the 0048 single-entry-point rule, unchanged.
--
-- Body is 0118's, with ONLY the engine loop changed. The parts arm, the
-- payment/credit-limit/override logic and the supplier-less path (0059) are
-- byte-for-byte 0118 — read that header before touching any of it.
-- ---------------------------------------------------------------------------
```

Then the full `create or replace function public.fn_receive_stock(...)` copied
from `0118_fractional_qty_stock.sql:88-411`, with the engine loop replaced by:

```sql
  for r in
    select * from jsonb_to_recordset(coalesce(p_engines, '[]'::jsonb))
      as x(serial_number text, engine_model_id uuid, condition text,
           cost_centavos bigint, price_centavos bigint, warranty_months int,
           new_model jsonb, qty int)
  loop
    v_eng_qty := coalesce(r.qty, 1);
    v_has_serial := length(trim(coalesce(r.serial_number, ''))) > 0;

    if v_eng_qty < 1 then
      raise exception 'An engine line needs at least one unit';
    end if;
    if v_has_serial and v_eng_qty > 1 then
      raise exception
        'One serial cannot describe % units — leave it blank and the system '
        'will number them', v_eng_qty;
    end if;

    if coalesce(r.price_centavos, 0) > 0
       and coalesce(r.price_centavos, 0) <= coalesce(r.cost_centavos, 0) then
      raise exception 'Selling price ₱% must be above cost ₱%',
        to_char(r.price_centavos/100.0, 'FM999,999,990.00'),
        to_char(coalesce(r.cost_centavos,0)/100.0, 'FM999,999,990.00');
    end if;

    v_model_id := r.engine_model_id;

    if v_model_id is null and r.new_model is not null then
      v_np := r.new_model;
      if coalesce(trim(v_np->>'brand'), '') = ''
         or coalesce(trim(v_np->>'model'), '') = '' then
        raise exception 'New engine model line missing brand/model';
      end if;

      select id into v_model_id
      from engine_models
      where lower(brand) = lower(trim(v_np->>'brand'))
        and lower(model) = lower(trim(v_np->>'model'))
        and deleted_at is null;

      if v_model_id is null then
        insert into engine_models
          (brand, model, horsepower, stroke, default_warranty_months,
           preferred_supplier_id, is_serialized, sku)
        values
          (trim(v_np->>'brand'),
           trim(v_np->>'model'),
           (v_np->>'horsepower')::numeric,
           nullif(trim(coalesce(v_np->>'stroke', '')), ''),
           coalesce((v_np->>'default_warranty_months')::int, 12),
           coalesce((v_np->>'preferred_supplier_id')::uuid, p_supplier_id),
           coalesce((v_np->>'is_serialized')::boolean, true),
           nullif(trim(coalesce(v_np->>'sku', '')), ''))
        returning id into v_model_id;
      end if;
    end if;

    if v_model_id is null then
      raise exception 'Engine line missing engine_model_id';
    end if;

    select is_serialized, brand || ' ' || model
      into v_serialized, v_model_label
    from engine_models where id = v_model_id;

    -- The model decides. Plates matter on a serialized model, so each is typed.
    if v_serialized and v_eng_qty > 1 then
      raise exception
        '% units of % have serial numbers — add them one at a time, or mark the '
        'model as having no serials first', v_eng_qty, v_model_label;
    end if;
    if v_serialized and not v_has_serial then
      raise exception 'Engine line missing serial_number for %', v_model_label;
    end if;

    for v_i in 1 .. v_eng_qty loop
      if v_has_serial then
        v_serial := trim(r.serial_number);
      else
        v_serial := public.fn_generate_engine_unit_no();
      end if;

      begin
        insert into engines
          (serial_number, engine_model_id, condition, cost_centavos,
           price_centavos, warranty_months, status)
        values
          (v_serial, v_model_id,
           coalesce(r.condition, 'brand_new'),
           coalesce(r.cost_centavos, 0), coalesce(r.price_centavos, 0),
           r.warranty_months, 'in_master')
        returning id into v_engine_id;
      exception when unique_violation then
        raise exception 'Serial % already exists', v_serial;
      end;

      insert into receiving_lines (receiving_id, engine_id, qty, unit_cost_centavos)
      values (v_receiving_id, v_engine_id, 1, coalesce(r.cost_centavos, 0));

      insert into stock_movements
        (movement_type, engine_id, qty_change, shop_id, actor, receiving_id, note)
      values
        ('received', v_engine_id, 1, null, auth.uid(), v_receiving_id, p_note);

      v_total := v_total + coalesce(r.cost_centavos, 0);
      v_count := v_count + 1;
    end loop;
  end loop;
```

Add to the `declare` block, alongside 0118's existing locals:

```sql
  v_eng_qty     int;
  v_i           int;
  v_serial      text;
  v_has_serial  boolean;
  v_serialized  boolean;
  v_model_label text;
```

- [ ] **Step 4: Apply to staging and run the test**

Paste the file into the staging SQL editor, then:

Run: `node scripts/test-engine-nonserial.mjs`
Expected: PASS — all seven sections.

- [ ] **Step 5: Prove nothing else regressed**

Run each, expecting exit 0:
```
node scripts/test-receiving.mjs
node scripts/test-receiving-inline.mjs
node scripts/test-custom-product.mjs
node scripts/test-catalog-lock.mjs
node scripts/test-warranties.mjs
node scripts/test-definer-guards.mjs
```

These cover the parts arm, inline creation, the 0049 lockdown, the warranty path
and the new definer function's caller guard — the things a `fn_receive_stock`
rewrite can break.

**Never pipe a suite through `head`** — it dies on EPIPE before cleanup and
leaves fixtures behind. Redirect to a file.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0129_receive_engine_qty.sql scripts/test-engine-nonserial.mjs
git commit -m "feat(db): 0129 — a quantity on the engine line, for models without serials

{engine_model_id, qty: 5} on a non-serialized model creates five units numbered
UNIT-########. On a serialized model it is REFUSED — if the units have plates,
each plate matters and each is typed. That refusal is the feature: it stops a
real serial being replaced by a system number by accident.

Still one row per unit: five rows, five receiving_lines at qty 1, five +1 ledger
rows. The five engine qty=1 CHECKs, every p_qty <> 1 guard and one-warranty-per-
unit are untouched.

new_model gains is_serialized and sku so a non-serialized model can be created
inline on the receiving that first stocks it (0048's single entry point)."
```

---

### Task 3: The model editor — the toggle and the code

**Files:**
- Modify: `app/(owner)/master-inventory/reference-data-dialogs.tsx`
- Modify: `app/(owner)/master-inventory/actions.ts`

**Interfaces:**
- Consumes: `engine_models.is_serialized`, `engine_models.sku` (Task 1).
- Produces: nothing for later tasks.

Gerry must be able to mark a model as having no serials **before** he receives
it, and to fix a model he got wrong. `reference-data-dialogs.tsx` is where engine
models are renamed and retired today (see `:63-67` for the existing row shape).

- [ ] **Step 1: Widen the model schema in the server action**

In `app/(owner)/master-inventory/actions.ts`, the engine-model object gains:

```ts
  is_serialized: z.boolean().default(true),
  sku: z.string().trim().max(80).optional().nullable(),
```

Carry both through the existing upsert. No `isPrimaryOwner()` gate — editing
model reference data is office-tier, exactly like renaming one today. Retiring a
model stays Gerry-only (0102) and is untouched.

- [ ] **Step 2: Add the two controls to the model row**

In the engine-model dialog, beside brand/model/horsepower:

```tsx
<div className="grid gap-1.5">
  <Label htmlFor={`sku-${row.id}`}>Product code</Label>
  <Input
    id={`sku-${row.id}`}
    value={row.sku}
    placeholder="e.g. HONDA-GX35-2026"
    onChange={(e) => setRow(row.id, { sku: e.target.value })}
    aria-label={`Product code for ${row.brand} ${row.model}`}
  />
</div>

<label className="flex items-start gap-2 rounded-md border p-2.5">
  <Checkbox
    checked={row.is_serialized}
    onCheckedChange={(v) => setRow(row.id, { is_serialized: v === true })}
    aria-label={`Units of ${row.brand} ${row.model} have serial numbers`}
  />
  <span className="text-sm">
    <span className="font-medium">Units have serial numbers</span>
    <span className="block text-xs text-muted-foreground">
      Leave this on for outboards with a plate on the block. Turn it OFF for
      engines that share one product code — then you can receive several at once
      and the system numbers them for you.
    </span>
  </span>
</label>
```

The `aria-label`s matter: the QA harness addresses rows by label, never
positionally, because a positional click once resolved the wrong row and moved
real stock (`scripts/qa-browser/README.md`).

- [ ] **Step 3: Show it in the Engines view**

In `app/(owner)/master-inventory/engines-table.tsx`, on the model grouping,
render a quiet badge when a model is non-serialized so the state is visible
without opening the dialog:

```tsx
{!model.is_serialized && (
  <Badge variant="outline" className="text-muted-foreground">no serials</Badge>
)}
```

Add `is_serialized` and `sku` to the page's `select` and the row type.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add "app/(owner)/master-inventory/reference-data-dialogs.tsx" "app/(owner)/master-inventory/actions.ts" "app/(owner)/master-inventory/engines-table.tsx"
git commit -m "feat(master-inventory): mark an engine model as having no serials

A 'Units have serial numbers' toggle and a product code on the engine model.
Turning the toggle off is what lets Receiving take a quantity for that model.
Office tier, like renaming a model; retiring one stays Gerry-only (0102)."
```

---

### Task 4: Receiving UI — the quantity box

**Files:**
- Modify: `app/(owner)/suppliers/receiving-view.tsx` (engine lines, `:1600-1640`)
- Modify: `app/(owner)/suppliers/actions.ts` (engine line schema, `:116` area)

**Interfaces:**
- Consumes: `fn_receive_stock`'s engine payload from Task 2 — `{ engine_model_id, serial_number?, qty?, cost_centavos, price_centavos, condition?, warranty_months?, new_model? }`.
- Produces: nothing for later tasks.

- [ ] **Step 1: Widen the server action's engine schema**

In `app/(owner)/suppliers/actions.ts`:

```ts
          qty: z.number().int().min(1).max(500).default(1),
          serial_number: z.string().trim().max(120).optional().nullable(),
```

`int`, not `qtySchema()` — an engine is a countable unit. `max(500)` is a
fat-finger guard, not a business rule.

And in the inline `new_model` object:

```ts
            is_serialized: z.boolean().default(true),
            sku: z.string().trim().max(80).optional().nullable(),
```

- [ ] **Step 2: Add `qty` to the engine line state and grid**

Add `qty: string` to the `EngineLine` type, defaulting `"1"` in
`emptyEngineLine()`. Add a `Qty` column header and:

```tsx
<Input
  inputMode="numeric"
  aria-label="Engine quantity"
  className="w-16 tabular-nums"
  value={l.qty}
  onChange={(e) => updateEngineLine(i, { qty: e.target.value.replace(/\D/g, "") })}
  disabled={serializedFor(l)}
/>
```

Stripping non-digits is correct **here** — unlike a part quantity, an engine
count is a whole number and the decimal point is genuinely unwanted. See
`lib/format.ts#sanitizeQtyInput` for why part quantities must never do this.

- [ ] **Step 3: Drive both boxes off the picked model**

The picker already loads engine models. Add `is_serialized` to that fetch and:

```tsx
/** A model with plates: serial required, quantity locked at 1. */
const serializedFor = (l: EngineLine) =>
  l.new_model
    ? l.new_model.is_serialized
    : (models.find((m) => m.id === l.engine_model_id)?.is_serialized ?? true);
```

Then the serial input:

```tsx
<Input
  aria-label="Serial number"
  value={l.serial_number}
  disabled={!serializedFor(l)}
  placeholder={
    serializedFor(l)
      ? "scan or type the plate"
      : "no serials — numbered automatically"
  }
  onChange={(e) => updateEngineLine(i, { serial_number: e.target.value })}
/>
```

The two controls are mutually exclusive by construction, so the form can never
build a payload the RPC will reject. Default `true` when no model is picked yet
is deliberate — the safe assumption is that plates matter.

- [ ] **Step 4: Send it**

In the engine loop of `onSubmit` (`:1213` area):

```ts
        const engQty = serializedFor(l) ? 1 : (parseInt(l.qty || "1", 10) || 1);
        enginesPayload.push({
          engine_model_id: l.engine_model_id,
          serial_number: serializedFor(l) ? (l.serial_number.trim() || null) : null,
          qty: engQty,
          cost_centavos: cost,
          price_centavos: price,
          condition: l.condition,
          warranty_months: warrantyMonths,
          new_model: l.new_model ?? undefined,
        });
```

- [ ] **Step 5: Add the toggle to the inline New Model dialog**

The inline dialog (`NewModelDialog`, near `:446`) gains the same checkbox and
code field as Task 3 Step 2, so a non-serialized model can be created on the
receiving that first stocks it.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Drive it in the browser**

Create `scripts/qa-browser/en1-receive-qty.mjs`, reusing `openReceiving()` and
`submitReceiving()` from `scripts/qa-browser/fq1-receiving.mjs` verbatim —
including the credit-limit override, because every seeded supplier is over its
limit and the form legitimately demands a reason.

Assert: with a non-serialized model picked, the Qty box is enabled and the serial
box is disabled; entering `3` saves; the DB then holds three `engines` rows with
distinct `UNIT-` numbers. Then pick a serialized model and assert the reverse —
Qty locked at 1, serial required.

Selector notes that will otherwise cost an hour (`scripts/qa-browser/README.md`):
- `role="combobox"` takes no accessible name from its content — locate by text
- never `.last()` on `button[role="combobox"]`; the DataTable's "Rows per page"
  select sits after the form and wins
- a receiving succeeds with a **dialog** ("Stock received"), not a toast — race
  the dialog against the refusal toast or a refusal reads as silence

Run: `node scripts/qa-browser/en1-receive-qty.mjs`
Expected: all checks pass.

- [ ] **Step 8: Commit**

```bash
git add "app/(owner)/suppliers/receiving-view.tsx" "app/(owner)/suppliers/actions.ts" scripts/qa-browser/en1-receive-qty.mjs
git commit -m "feat(receiving): quantity on the engine line for models without serials

Pick a model with no serials and the Qty box enables while the serial box
disables; pick a serialized one and it is the other way round. The two are
mutually exclusive by construction, so the form cannot build a payload the RPC
will reject. Defaults to serialized when no model is picked — the safe
assumption is that plates matter."
```

---

### Task 5: Documentation, full suite, release

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the schema line**

`engine_models` in "Core inventory" becomes:

```
`engine_models` (+`is_serialized` and `sku` since 0128 — a model whose units
carry no plate shares one product code, and only such a model may be received
by the quantity)
```

- [ ] **Step 2: Append to the Migrations list**

```
· `0128`/`0129` **non-serialized engine models** — Gerry buys five identical
small engines that share ONE product code and have no per-unit plate. Every
engine needed its own unique serial, so he added one and the system refused the
rest; he was typing the shared code into the serial box because that was the
only way in. **Serialization becomes a property of the MODEL**
(`engine_models.is_serialized`, default true so all 30 existing models are
untouched) — the `units.allows_fractional` decision from 0114, for the same
reason: a Yamaha 40HP has plates and a cheap brush cutter does not, and that is
a fact about the model, not something to remember per unit. `sku` holds the
shared code and mirrors `parts.sku` (same concept, same word, also not unique);
searchable, not scanned. A receiving engine line may carry `qty` **only** for a
non-serialized model — on a serialized one it is REFUSED, which is the feature:
it stops a real plate being replaced by a system number by accident. Units of a
non-serialized model are numbered `UNIT-########`
(`fn_generate_engine_unit_no`, mirroring `fn_generate_internal_barcode`); a
minted value rather than a nullable serial because 146 app sites read
`serial_number` as a string. **Engines remain ONE ROW PER PHYSICAL UNIT** — five
units are five `engines` rows, five `receiving_lines` at qty 1 and five `+1`
ledger rows, so the five `check (engine_id is null or qty = 1)` constraints,
every `p_qty <> 1` guard and one-warranty-per-unit are all untouched. Serial AND
`qty > 1` together is refused, not reconciled. `new_model` gains
`is_serialized`/`sku` so such a model can be created inline on the receiving
that first stocks it (0048). `test-engine-nonserial.mjs` exits 2 until 0128 is
applied.
```

- [ ] **Step 2b: Add to the Suites list**

```
engine-nonserial (0128/0129: five units from one line on a non-serialized model,
distinct UNIT- numbers, qty refused on a serialized model, serial still required
there, serial+qty refused, inline non-serialized model creation, and a
non-serialized unit selling and warranting like any other)
```

- [ ] **Step 3: Full suite against staging**

Run: `npm test > /tmp/full.log 2>&1; echo "exit $?"; tail -40 /tmp/full.log`
Expected: exit 0. Redirect — never `| head`.

Then: `npm test -- --with-http > /tmp/http.log 2>&1; echo "exit $?"` (needs
`npm run dev`; pass `TEST_BASE_URL` if it moved off :3000).

- [ ] **Step 4: Deploy to staging and QA the deployed build**

```bash
git push origin <branch>
```
On the preview URL: mark a model as having no serials, receive 3 units, deliver
one, sell it, approve it, confirm the warranty exists. Then confirm a serialized
model still demands a serial and refuses a quantity.

- [ ] **Step 5: Release to production**

Follow `docs/RELEASE-fractional-quantities.md` as the template — it is this
project's worked example of a schema release. For this one:

- **No pre-flight data fix.** Both migrations are additive and every existing
  model keeps `is_serialized = true`, i.e. today's behaviour.
- Back up by hand and **download the artifact** first anyway.
- `cat supabase/.temp/project-ref` must read `wjvkrkbojnemfiuuitmu` before
  pushing — and the CLI being linked there is a hazard on every other day, which
  `scripts/_env-guard.mjs` cannot catch.
- Verify after: `select count(*) from engine_models where not is_serialized;` →
  **0**, plus the ledger invariant from the runbook §2.3.
- Schema first, then merge `main`. Old code on the new schema is safe: it never
  sends `qty` on an engine line, and `coalesce(r.qty, 1)` makes that exactly the
  previous behaviour.
- Afterwards, sit with Gerry and switch the handful of models that have no
  plates. That is the only data change, and it is his to make.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: 0128/0129 non-serialized engine models"
```

---

## Self-Review

**Spec coverage.** Gerry's stated requirement — *"the engine has no serials but
one code for all 5 units"* — is met by Task 1 (where the fact lives), Task 2
(receiving by quantity), Task 3 (setting it) and Task 4 (using it). The shared
code has a home on the model rather than being repeated on five units.

**What was rejected, and why it is recorded here.** The literal first reading,
one `engines` row holding a quantity, would have rebuilt the warranty system
(`warranties.engine_id` is unique — one row of five units cannot warrant unit #3
alone), deleted the engine chain-of-custody page and removed serial lookup at
the till. Making these items ordinary `parts` was cheaper still — zero
migrations — but loses warranty-on-sale, and Gerry sells engines with warranty
cards. Both were put to the client and declined.

**Deliberately out of scope.** Duplicate *real* serials remain impossible; that
uniqueness is what makes a warranty claim resolvable to one unit. Bulk-adding a
*serialized* model is refused rather than supported — if that becomes a real
need, the trigger is Gerry asking to receive several plated outboards without
unpacking them, and it would be a placeholder-serial feature of its own. The
code is searchable, not scannable, per the client's answer; `parts` keeps
scannable codes in a separate `barcode` column if that ever changes.

**Risk.** Task 2 rewrites `fn_receive_stock`, the single entry point for all
stock, whose body also carries the parts arm, the payables logic and the 0059
supplier-less path. Mitigation: copy 0118 whole, change only the engine loop,
then run the six suites in Task 2 Step 5 that cover what this task does not
touch.

**Type consistency check.** `is_serialized` and `sku` are the column names in
Tasks 1, 2, 3, 4 and 5, and the same keys in the `new_model` payload in Tasks 2
and 4. The minting function is `fn_generate_engine_unit_no()` in Tasks 1 and 2.
The minted format is `UNIT-` + 8 digits in Task 1 and in the assertions in Task
2. The engine payload key is `qty` in Tasks 2 and 4. `serializedFor(l)` is
defined once in Task 4 Step 3 and used in Steps 2, 3 and 4 of that task.
