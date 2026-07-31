# Page-Speed Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every owner and shop page renders usable in **< 1.5 s** at the current 1-month dataset, and *stays* under that when the 3-year dataset is loaded — production-ready.

**Architecture:** The DB/aggregate layer is already optimized (0073 indexes, 0074 dashboard/badge aggregates, 0075 P&L facts, 0076 RLS InitPlan). This plan closes the gaps the measurement surfaced: a per-request profile query fired 2–3×, a shop layout that blocks *every* shop page on 4 queries, an RLS-InitPlan regression the security migrations (0106/0107) reintroduced on the four biggest tables, and a set of `fetchAll` row-walks that are cheap at 1-month but scale O(transactions) at 3-year. Fixes follow the existing patterns: `cache()` for per-request dedup, one aggregate `SECURITY DEFINER` RPC per hot layout, `(select auth_helper())` in every policy.

**Tech Stack:** Next.js 16 (App Router, server components, streaming Suspense), Supabase Postgres + RLS, `SECURITY DEFINER` RPCs, Playwright for timing, the `scripts/_harness.mjs` DB test harness.

## Global Constraints

- **Migrations are applied by the user**, not the agent (no DB connection from the dev box). Every DB task ends by handing the user exact SQL to run, then re-runs the verifying suite after they confirm.
- **Do NOT touch migrations 0085–0098** (a reverted experiment).
- **Never write to the live `settings` row outside a try/finally restore.**
- **Any RLS policy MUST wrap auth helpers in a scalar subquery** — `(select public.is_owner())`, `(select public.auth_shop_id())` — or it reintroduces the per-row seq scan (0076). This is the single most important rule in this plan.
- **Money math must stay byte-identical** — `lib/pnl.ts` is the one source of truth; never reimplement it. Any aggregate that touches money is proven against the row-walk, never eyeballed.
- **Harness rules:** provision a throwaway shop, never hardcode a shop UUID, never sign in as a real shop login, one `cleanup()` at the end, scope every filter to `RUN`.
- **No commits** unless the user asks — leave changes in the working tree.
- Test-suite command: `node scripts/<suite>.mjs`; full run `npm test` (add `--with-http` for HTTP suites, needs `npm run dev`).

---

## Measured Baseline (production build `next start`, 1-month data)

> Absolute numbers are inflated by this dev box's ~250 ms round-trip to Supabase `ap-southeast-1`; on Vercel (same region) the fixed RTT is ~1–5 ms. The **shape** is the signal: owner pages are already fine; **every shop page is uniformly ~900–1080 ms**, which can only be a shared cost in the shop layout, not per-page work.

| Bucket | TTFB range | Data-complete range | Verdict |
|---|---|---|---|
| Owner pages (23 measured) | 245–596 ms | 300–813 ms | already < 1.5 s |
| **Shop pages (10 measured)** | **878–1078 ms** | **924–1171 ms** | **uniformly slow — layout tax** |

Slowest shop pages: Record Sale 1078 ms, My Stock 1074 ms, Transfers 1072 ms — all dominated by TTFB (server render), so the cost is server-side blocking queries, not client JS.

Root causes identified (each maps to a task below):
1. **Shop layout blocks every page on 4 queries** — `app/(shop)/layout.tsx` awaits `requireEmployee()` (1 profile query) **then** a `Promise.all` of shop name + 3 badge-count view queries (`shop_incoming_deliveries`, `shop_low_stock_safe`, `shop_receivables`) before the shell paints. The owner layout deliberately does none of this (badges are client-fetched). → **Task 3** (biggest shop win).
2. **`getProfile()` is not request-deduped** — the layout calls it, then several `page.tsx` call it again (e.g. `master-inventory/page.tsx` ×3, `expenses`, `shops`, `receivables`), each a separate round-trip. → **Task 2**.
3. **RLS InitPlan regression** — 0106/0107 dropped-and-recreated the `sales`, `sale_lines`, `losses`, `customers` policies with **bare** `public.is_owner()` / `public.auth_shop_id()`, reverting 0076 on the four highest-row tables. Invisible at 1-month; at 3-year it reintroduces per-row seq scans (0076's evidence: pending-count 335 ms → 2.3 s). → **Task 1** (do first — it's a regression I shipped).
4. **`fetchAll` row-walks** in 8 owner/shop pages (receivables, suppliers, suki-cards, reports tabs, shops, shop/receivables) sum raw rows in JS — O(transactions). Fine now, a 3-year risk. → **Task 4** (audit + fix the O(transactions) ones), validated at 3-year in **Task 5**.

---

## File Structure

- `supabase/migrations/0108_restore_rls_initplan.sql` — **create**: re-wrap the 0106/0107 policies' auth helpers in `(select …)`.
- `supabase/migrations/0109_shop_badge_counts.sql` — **create**: `fn_shop_badge_counts()` aggregate RPC (one round-trip for the 3 shop badge counts + shop name).
- `lib/auth.ts` — **modify**: wrap `getProfile` in React `cache()`.
- `lib/shop-nav.ts` — **create**: `getShopBadgeCounts()` (RPC + graceful fallback), mirroring `lib/dashboard.ts`'s pattern.
- `app/(shop)/layout.tsx` — **modify**: use `getShopBadgeCounts()` (1 round-trip) instead of the 4-query `Promise.all`; keep it seeded (fast) but off the critical shell path where possible.
- `scripts/test-perf-guards.mjs` — **create**: static + behavioral guards (no bare auth helper in the new policies; `getProfile` deduped; shop layout issues ≤1 badge round-trip).
- `scripts/test-approval-integrity.mjs`, `scripts/test-customer-privacy.mjs` — **reuse**: prove 0108 didn't change behavior.
- `scripts/measure-speed.mjs` (in scratchpad) — **reuse**: the timing harness for before/after and the 3-year re-measure.
- Per-page `fetchAll` conversions in Task 4 name their own files.

---

### Task 1: Restore the RLS InitPlan wrapping on the security-fix policies (P0 — regression)

**Files:**
- Create: `supabase/migrations/0108_restore_rls_initplan.sql`
- Test: `scripts/test-perf-guards.mjs` (static grep) + reuse `scripts/test-approval-integrity.mjs`, `scripts/test-customer-privacy.mjs`

**Interfaces:**
- Consumes: the policy bodies from 0106 (`sales_update`, `sale_lines_insert/update/delete`, `losses_update`) and 0107 (`customers_select`).
- Produces: identical policies, semantically unchanged, with every `public.is_owner()` → `(select public.is_owner())` and `public.auth_shop_id()` → `(select public.auth_shop_id())`.

- [ ] **Step 1: Write the failing guard test** in `scripts/test-perf-guards.mjs`

```js
import { readFileSync } from "node:fs";
import { check, section, summary } from "./_harness.mjs";

section("RLS InitPlan: no BARE auth helpers in 0106/0107/0108 policies");
for (const f of [
  "supabase/migrations/0106_freeze_submitted_items.sql",
  "supabase/migrations/0107_customer_privacy.sql",
  "supabase/migrations/0108_restore_rls_initplan.sql",
]) {
  let sql = "";
  try { sql = readFileSync(f, "utf8"); } catch { /* 0108 not written yet */ }
  // a bare call is is_owner()/auth_shop_id() NOT preceded by "select "
  const bare = [...sql.matchAll(/(?<!select\s)public\.(is_owner|auth_shop_id)\s*\(\s*\)/g)];
  check(`${f}: 0 bare auth-helper calls`, bare.length === 0, `${bare.length} bare`);
}
summary();
```

- [ ] **Step 2: Run it — expect FAIL** (0106/0107 still have bare calls; 0108 absent)

Run: `node scripts/test-perf-guards.mjs`
Expected: FAIL — "0106…: N bare", "0107…: N bare".

- [ ] **Step 3: Write `0108_restore_rls_initplan.sql`** — the six policies, byte-identical to 0106/0107 except every helper wrapped. Full SQL:

```sql
-- 0108 — Restore the 0076 InitPlan wrapping on the 0106/0107 policies.
-- 0106/0107 recreated these with BARE public.is_owner()/auth_shop_id(), which
-- Postgres evaluates once PER ROW → seq scan on sales/sale_lines/losses/customers
-- at scale. Wrapping each in a scalar subquery hoists it to a single InitPlan.
-- Bodies are otherwise identical to 0106/0107; only eval frequency changes.

drop policy if exists sales_update on public.sales;
create policy sales_update on public.sales for update
  to authenticated using (
    (select public.is_owner())
    or (shop_id = (select public.auth_shop_id()) and recorded_by = auth.uid()
        and status in ('recorded','questioned'))
  ) with check (
    (select public.is_owner())
    or (shop_id = (select public.auth_shop_id()) and recorded_by = auth.uid()
        and status = 'recorded')
  );

drop policy if exists sale_lines_insert on public.sale_lines;
create policy sale_lines_insert on public.sale_lines for insert
  to authenticated with check (
    exists (select 1 from public.sales s where s.id = sale_id
      and ((select public.is_owner())
           or (s.shop_id = (select public.auth_shop_id()) and s.recorded_by = auth.uid()
               and s.status = 'recorded'))));

drop policy if exists sale_lines_update on public.sale_lines;
create policy sale_lines_update on public.sale_lines for update
  to authenticated using (
    exists (select 1 from public.sales s where s.id = sale_id
      and ((select public.is_owner())
           or (s.shop_id = (select public.auth_shop_id()) and s.recorded_by = auth.uid()
               and s.status = 'recorded'))));

drop policy if exists sale_lines_delete on public.sale_lines;
create policy sale_lines_delete on public.sale_lines for delete
  to authenticated using (
    exists (select 1 from public.sales s where s.id = sale_id
      and ((select public.is_owner())
           or (s.shop_id = (select public.auth_shop_id()) and s.recorded_by = auth.uid()
               and s.status = 'recorded'))));

drop policy if exists losses_update on public.losses;
create policy losses_update on public.losses for update
  to authenticated using (
    (select public.is_owner())
    or (shop_id = (select public.auth_shop_id()) and recorded_by = auth.uid()
        and status in ('recorded','questioned'))
  ) with check (
    (select public.is_owner())
    or (shop_id = (select public.auth_shop_id()) and recorded_by = auth.uid()
        and status = 'recorded')
  );

drop policy if exists customers_select on public.customers;
create policy customers_select on public.customers for select
  to authenticated using (
    (select public.is_owner())
    or exists (select 1 from public.sales s
               where s.customer_id = customers.id
                 and s.shop_id = (select public.auth_shop_id())
                 and s.deleted_at is null)
  );
```

- [ ] **Step 4: Hand the SQL to the user to apply**, then run the guard test

Run (after user applies): `node scripts/test-perf-guards.mjs`
Expected: PASS — 0 bare in all three files.

- [ ] **Step 5: Prove behavior is unchanged** (security intact)

Run: `node scripts/test-approval-integrity.mjs && node scripts/test-customer-privacy.mjs && node scripts/test-rls.mjs`
Expected: 13/13, 8/8, 53/53 — all pass. The InitPlan change is semantics-preserving; these must stay green.

- [ ] **Step 6: Commit** (only if the user has opted into commits)

```bash
git add supabase/migrations/0108_restore_rls_initplan.sql scripts/test-perf-guards.mjs
git commit -m "perf: restore RLS InitPlan wrapping on 0106/0107 policies"
```

---

### Task 2: Deduplicate `getProfile()` per request with React `cache()` (P1)

**Files:**
- Modify: `lib/auth.ts:17-38` (the `getProfile` function)
- Test: reuse full `npm test` (auth-touching suites must stay green); add a note to `scripts/test-perf-guards.mjs`.

**Interfaces:**
- Consumes: nothing new.
- Produces: `getProfile` memoised for the lifetime of one server request, so layout + page + actions share a single `profiles` round-trip. Signature unchanged: `getProfile(): Promise<Profile | null>`.

- [ ] **Step 1: Add the guard assertion** to `scripts/test-perf-guards.mjs`

```js
section("getProfile is request-cached");
const auth = readFileSync("lib/auth.ts", "utf8");
check("lib/auth.ts imports react cache", /import\s*\{[^}]*\bcache\b[^}]*\}\s*from\s*"react"/.test(auth));
check("getProfile is wrapped in cache(", /getProfile\s*=\s*cache\(/.test(auth));
```

- [ ] **Step 2: Run it — expect FAIL** (not yet wrapped)

Run: `node scripts/test-perf-guards.mjs`
Expected: FAIL on the two getProfile assertions.

- [ ] **Step 3: Wrap `getProfile` in `cache()`** in `lib/auth.ts`

Change the import line to add `cache`:
```ts
import { cache } from "react";
```
Convert the declaration (keep the retry-once body from the earlier BUG-1 fix intact — only the wrapper changes):
```ts
/** Current user's profile (role + shop scope), or null if signed out.
 *  cache() dedupes it per request — layout, page, and actions share one hit. */
export const getProfile = cache(async (): Promise<Profile | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const query = () =>
    supabase.from("profiles")
      .select("id, full_name, role, shop_id, active")
      .eq("id", user.id).maybeSingle();

  let res = await query();
  if (res.error) res = await query();
  if (res.error) throw new Error(`Profile lookup failed: ${res.error.message}`);

  const { data } = res;
  if (!data || !data.active) return null;
  const { active: _active, ...profile } = data;
  return profile as Profile;
});
```

- [ ] **Step 4: Typecheck + guard test**

Run: `npx tsc --noEmit && node scripts/test-perf-guards.mjs`
Expected: tsc clean; guard test passes the getProfile assertions.

- [ ] **Step 5: Prove auth behavior unchanged**

Run: `node scripts/test-rls.mjs && node scripts/test-admin-accounts.mjs && node scripts/test-shop-recording.mjs`
Expected: 53/53, 30/30, 24/24 — deactivation-cuts-access, tier gates, and shop scoping all still hold (`cache()` only affects duplicate calls within one request; `auth.getUser()` still validates the session every request).

- [ ] **Step 6: Commit** (if opted in)

```bash
git add lib/auth.ts scripts/test-perf-guards.mjs
git commit -m "perf: request-cache getProfile to dedupe per-request profile queries"
```

---

### Task 3: Collapse the shop layout's 4 blocking queries into one aggregate RPC (P1 — biggest shop win)

**Files:**
- Create: `supabase/migrations/0109_shop_badge_counts.sql`
- Create: `lib/shop-nav.ts`
- Modify: `app/(shop)/layout.tsx`
- Test: `scripts/test-shop-recording.mjs` (extend with a badge-count assertion) + `scripts/measure-speed.mjs` before/after

**Interfaces:**
- Consumes: `auth_shop_id()`, the shop-facing views `shop_incoming_deliveries`, `shop_low_stock_safe`, `shop_receivables`.
- Produces:
  - SQL: `fn_shop_badge_counts() returns jsonb` — `{ shop_name, deliveries, low_stock, receivables }`, `SECURITY DEFINER`, employee-guarded, `(select …)`-safe, one round-trip. Revoked from `public, anon`; granted to `authenticated`.
  - TS: `getShopBadgeCounts(): Promise<{ shopName: string; badges: Record<string,number> }>` in `lib/shop-nav.ts` — tries the RPC, falls back to the current 4-query path if 0109 isn't applied.

- [ ] **Step 1: Write the failing SQL-shape test** in `scripts/test-shop-badges.mjs`

```js
import { owner, provisionShop, seedPart, receive, deliverAndConfirm, check, section, summary, cleanup } from "./_harness.mjs";
const A = await provisionShop("Badges");
section("fn_shop_badge_counts returns the three counts in one call");
const { data, error } = await A.client.rpc("fn_shop_badge_counts");
check("rpc exists + returns object", !error && data && typeof data === "object", error?.message);
check("has deliveries/low_stock/receivables keys",
  data && ["deliveries","low_stock","receivables"].every((k) => k in data), JSON.stringify(data));
check("employee-scoped shop_name present", !!data?.shop_name, JSON.stringify(data));
await cleanup();
summary();
```

- [ ] **Step 2: Run it — expect FAIL** ("function fn_shop_badge_counts does not exist")

Run: `node scripts/test-shop-badges.mjs`
Expected: FAIL.

- [ ] **Step 3: Write `0109_shop_badge_counts.sql`**

```sql
-- 0109 — one round-trip for the shop nav badge counts + shop name.
-- The shop layout blocked every shop page on getProfile + 4 separate view
-- queries. This returns all of it in a single SECURITY DEFINER call, scoped to
-- the caller's own shop. Read-only (like fn_stock_card / fn_cron_job_health).
create or replace function public.fn_shop_badge_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_shop uuid;
  v_name text;
  v_del int; v_low int; v_rec int;
begin
  v_shop := (select shop_id from profiles
             where id = auth.uid() and role = 'employee' and active and deleted_at is null);
  if v_shop is null then
    raise exception 'Only shop staff can read shop badge counts';
  end if;

  select name into v_name from shops where id = v_shop;
  select count(*) into v_del  from shop_incoming_deliveries where status = 'in_transit';
  select count(*) into v_low  from shop_low_stock_safe;
  select count(*) into v_rec  from shop_receivables where balance_centavos > 0;

  return jsonb_build_object(
    'shop_name', coalesce(v_name, 'My Shop'),
    'deliveries', v_del, 'low_stock', v_low, 'receivables', v_rec
  );
end $$;

revoke all on function public.fn_shop_badge_counts() from public, anon;
grant execute on function public.fn_shop_badge_counts() to authenticated;
```

- [ ] **Step 4: Hand SQL to the user to apply**, then run the shape test

Run: `node scripts/test-shop-badges.mjs`
Expected: PASS — 3/3.

- [ ] **Step 5: Write `lib/shop-nav.ts`** (RPC + graceful fallback, mirroring `lib/dashboard.ts`)

```ts
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

export interface ShopNav {
  shopName: string;
  badges: { "/shop/deliveries": number; "/shop/low-stock": number; "/shop/receivables": number };
}

export const getShopBadgeCounts = cache(async (shopId: string | null): Promise<ShopNav> => {
  const supabase = await createClient();
  const empty: ShopNav = { shopName: "My Shop", badges: { "/shop/deliveries": 0, "/shop/low-stock": 0, "/shop/receivables": 0 } };
  if (!shopId) return empty;

  // fast path: one aggregate round-trip
  const { data, error } = await supabase.rpc("fn_shop_badge_counts");
  if (!error && data) {
    return {
      shopName: (data as any).shop_name ?? "My Shop",
      badges: {
        "/shop/deliveries": (data as any).deliveries ?? 0,
        "/shop/low-stock": (data as any).low_stock ?? 0,
        "/shop/receivables": (data as any).receivables ?? 0,
      },
    };
  }

  // fallback: the pre-0109 four-query path (correct, heavier)
  const head = { count: "exact" as const, head: true };
  const [nameRes, delRes, lowRes, recRes] = await Promise.all([
    supabase.from("shops").select("name").eq("id", shopId).single(),
    supabase.from("shop_incoming_deliveries").select("*", head).eq("status", "in_transit"),
    supabase.from("shop_low_stock_safe").select("*", head),
    supabase.from("shop_receivables").select("*", head).gt("balance_centavos", 0),
  ]);
  return {
    shopName: nameRes.data?.name ?? "My Shop",
    badges: {
      "/shop/deliveries": delRes.count ?? 0,
      "/shop/low-stock": lowRes.count ?? 0,
      "/shop/receivables": recRes.count ?? 0,
    },
  };
});
```

- [ ] **Step 6: Rewrite `app/(shop)/layout.tsx`** to use it

Replace the inline `if (profile.shop_id) { … Promise.all of 4 queries … }` block with:
```tsx
import { requireEmployee } from "@/lib/auth";
import { getShopBadgeCounts } from "@/lib/shop-nav";
import { AppShell } from "@/components/shell/app-shell";

export default async function ShopLayout({ children }: { children: React.ReactNode }) {
  const profile = await requireEmployee();
  const { shopName, badges } = await getShopBadgeCounts(profile.shop_id);
  return (
    <AppShell variant="employee" userName={profile.full_name} contextLabel={shopName} badgeCounts={badges}>
      {children}
    </AppShell>
  );
}
```
(Net effect: `requireEmployee()` now shares the cached profile from Task 2, and the 4 badge queries become 1 RPC round-trip.)

- [ ] **Step 7: Typecheck + regression**

Run: `npx tsc --noEmit && node scripts/test-shop-recording.mjs && node scripts/test-shop-badges.mjs`
Expected: tsc clean; 24/24; 3/3.

- [ ] **Step 8: Measure the shop pages** (prod build)

Run: `npm run build && (npm run start &) ; ` then `node scratchpad/measure-speed.mjs` (or the shop-only subset).
Expected: shop-page TTFB drops materially from the ~900–1080 ms baseline (target the same band as owner pages, well under 1.5 s). Record the new numbers in the results file.

- [ ] **Step 9: Commit** (if opted in)

```bash
git add supabase/migrations/0109_shop_badge_counts.sql lib/shop-nav.ts "app/(shop)/layout.tsx" scripts/test-shop-badges.mjs
git commit -m "perf: one aggregate RPC for shop nav badges; unblock the shop layout"
```

---

### Task 4: Audit and fix the `fetchAll` row-walks for 3-year scale (P2)

The 8 `fetchAll`/`pageAll` sites sum raw rows in JS — O(transactions). At 1-month they're invisible; at 3-year they are the next cliff. Fix only the ones that scale with **transaction count** (not with a small fixed set like shops or suppliers). This task is one sub-task per hot site; each is independently testable and shippable.

**Files (one sub-task each):**
- `app/(owner)/receivables/page.tsx` + `app/(shop)/shop/receivables/page.tsx` — walk `utang_payments` to sum "paid since". Candidate: a `fn_receivables_summary` aggregate, or lean on the existing `receivables` view's computed `balance_centavos` and paginate the display only.
- `app/(owner)/suppliers/page.tsx` — walks receivings/payments for outstanding. Candidate: `fn_supplier_outstanding` (already exists) per supplier, or a single aggregate view.
- `app/(owner)/suki-cards/page.tsx` — walks sales for per-card usage. Candidate: `fn_suki_card_usage` aggregate (uses + Σ discount) grouped by card.
- `app/(owner)/reports/sales-tab.tsx`, `reports/shops-tab.tsx`, `expenses/reports/page.tsx` — largely already fed by 0075 facts; confirm the row-walk is fallback-only and not on the hot path.
- `app/(owner)/shops/page.tsx` — walks `stock_levels`/`engines` for per-shop unit counts. Candidate: a grouped-count RPC; bounded by shops×products, so lower priority.

**Method for EACH sub-task (repeat the cycle):**

- [ ] **Step 1:** Add a timing assertion to `scripts/measure-speed.mjs`'s list (or a targeted `EXPLAIN`-style DB test) capturing the page's current data-complete time at 1-month as the baseline.
- [ ] **Step 2:** Decide: does this site scale with transactions? If **no** (fixed small set), document why and skip. If **yes**, continue.
- [ ] **Step 3:** Write a failing test asserting the new aggregate RPC (or view) returns the same numbers as the row-walk on a provisioned fixture set (byte-identical for money — capture the row-walk output first, then compare).
- [ ] **Step 4:** Write the migration (aggregate RPC or view), `(select …)`-safe, `revoke from public,anon`, `grant to authenticated`, owner/shop-guarded.
- [ ] **Step 5:** Hand SQL to the user; apply; run the equivalence test → must be byte-identical.
- [ ] **Step 6:** Switch the page to the RPC with the row-walk kept as the documented fallback (the `lib/dashboard.ts` pattern).
- [ ] **Step 7:** `npx tsc --noEmit` + the page's feature suite + re-measure at 1-month (no regression).
- [ ] **Step 8:** Commit.

> Do **not** speculatively rewrite sites that don't scale with transactions — verify with the 3-year measurement in Task 5 first. Optimizing blind violates YAGNI and risks breaking money math.

---

### Task 5: Re-measure at 1-month, then gate on the 3-year dataset (P3)

**Files:**
- Reuse: `scratchpad/measure-speed.mjs`, `scripts/seed-load-test.mjs` + `seed-states.mjs` (the 3-year seed, per the seed-scripts memory — run in order).

- [ ] **Step 1: Re-measure all pages at 1-month** after Tasks 1–4 on a fresh `next build && next start`.

Run: rebuild, start, `node scratchpad/measure-speed.mjs`.
Expected: **every** page data-complete < 1.5 s; shop pages no longer the outliers; record the new table in `docs/superpowers/plans/` alongside this plan.

- [ ] **Step 2: Load the 3-year dataset** (user does this — "we will add 3 years seeded data later").

Run (user): `node scripts/db-fresh-start.mjs && node scripts/seed-load-test.mjs && node scripts/seed-states.mjs` (invariant-safe, in order).

- [ ] **Step 3: Re-measure all pages at 3-year.**

Run: rebuild, start, `node scratchpad/measure-speed.mjs`.
Expected: pages that were < 1.5 s at 1-month stay < 1.5 s. Any that regress are the true O(transactions) offenders → return to Task 4's cycle for exactly those pages (now with real evidence).

- [ ] **Step 4: Full regression + verification-before-completion.**

Run: `npm test` and `npm test -- --with-http` (with `npm run dev`).
Expected: all suites green. Use `superpowers:verification-before-completion` before declaring the work done — paste the actual passing output, don't assert.

- [ ] **Step 5: Update the CLAUDE.md migrations list** with 0106–0109 and note the perf posture (optional; user owns that doc).

---

## Self-Review

**Spec coverage:** the user's ask — "optimize all pages including shop, load < 1–1.5 s, production-ready, re-test at 3 years" — maps to: Task 3 (shop pages, the measured problem) + Task 2 (cross-cutting profile dedup) + Task 1 (don't let the security fix regress at scale) + Task 4 (3-year row-walk cliffs) + Task 5 (the explicit 1-month-then-3-year gate). Owner pages already meet the target and are protected, not rewritten.

**Placeholder scan:** every DB task ships exact SQL; every code task ships the full replacement; Task 4 is a repeated concrete cycle rather than "optimize the rest."

**Type consistency:** `getShopBadgeCounts(shopId)` → `{ shopName, badges }` consumed verbatim by the layout; `fn_shop_badge_counts` keys (`shop_name`/`deliveries`/`low_stock`/`receivables`) match between the SQL and `lib/shop-nav.ts`; `getProfile` signature is unchanged so all callers keep working.

**Ordering:** Task 1 first (it's a regression already in production DB), then 2 (broad, cheap), then 3 (biggest shop win, depends on 2's cache for full benefit), then 4 (evidence-driven), then 5 (the gate).
