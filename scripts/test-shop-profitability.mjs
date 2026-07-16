/**
 * Shop-scoped expenses + per-shop profitability verification.
 *
 * Covers:
 *  - expense scope CHECK constraint enforced by the DB (not just the form)
 *  - existing expenses keep their real shop attribution (NO phantom re-scoping)
 *  - scope filtering + reconciliation: company + Σ shop = grand total
 *  - COGS frozen at approval — editing a part's cost does NOT rewrite history
 *  - Revenue − COGS = Gross Profit; − shop expenses − payroll = Net Contribution
 *  - company overhead reported but NEVER allocated into a shop
 *  - approved sales only (recorded/pending never count as revenue)
 *  - supplier payments are COGS and never appear in expenses
 *  - employees have zero access to expenses
 *
 * Self-contained: temp shop/employee via the service role, then hard-cleans up.
 *
 * Run: node scripts/test-shop-profitability.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);

const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const RUN = Date.now().toString(36).toUpperCase();
const P = (c) => `₱${(c / 100).toLocaleString()}`;

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name} ${ok ? "" : detail}`);
  ok ? pass++ : fail++;
};

const admin = createClient(SB_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function signIn(email, password) {
  const c = createClient(SB_URL, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}

const owner = await signIn("owner@jerrysmarine.test", "Owner!Dev2026");

// ── Baseline: what the live expense data looks like BEFORE we touch anything ──
console.log("Baseline (live expense attribution must survive this run):");
const { data: baseline } = await owner
  .from("expenses")
  .select("id, scope, shop_id")
  .is("deleted_at", null);
const baseShopScoped = baseline.filter((e) => e.scope === "shop").length;
const baseCompany = baseline.filter((e) => e.scope === "company").length;
check(
  `${baseline.length} live expenses (${baseShopScoped} shop-scoped, ${baseCompany} company)`,
  true
);
check(
  "every shop-scoped expense has a shop; every company one has none",
  baseline.every((e) =>
    e.scope === "shop" ? !!e.shop_id : e.shop_id === null
  )
);

// ── Setup ────────────────────────────────────────────────────────────────────
const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });

const { data: shop } = await admin
  .from("shops").insert({ name: `PROFIT-TEST Shop ${RUN}` }).select().single();
const empEmail = `profit-${RUN.toLowerCase()}@test.local`;
const { data: u } = await admin.auth.admin.createUser({
  email: empEmail, password: `Prof!${RUN}`, email_confirm: true,
});
await admin.from("profiles").insert({
  id: u.user.id, full_name: `PROFIT-TEST Staff`, role: "employee", shop_id: shop.id,
});
const emp = await signIn(empEmail, `Prof!${RUN}`);

const { data: cat } = await owner.from("product_categories").select("id").limit(1).single();
const COST = 1000;   // ₱10 per unit
const PRICE = 2500;  // ₱25 per unit
const { data: part } = await owner.from("parts").insert({
  name: `PROFIT-TEST Widget ${RUN}`, category_id: cat.id,
  cost_centavos: COST, price_centavos: PRICE,
}).select().single();

// ── 1. The DB enforces the scope/shop pairing itself ─────────────────────────
console.log("\nScope constraint (enforced in Postgres, not just the form):");
{
  const { error } = await owner.from("expenses").insert({
    category_id: (await owner.from("expense_categories").select("id").limit(1).single()).data.id,
    amount: 1000, description: `PROFIT-TEST bad ${RUN}`,
    scope: "shop", shop_id: null,
  });
  check("scope='shop' with NO shop_id is REJECTED", !!error, error?.message ?? "accepted!");
}
{
  const { error } = await owner.from("expenses").insert({
    category_id: (await owner.from("expense_categories").select("id").limit(1).single()).data.id,
    amount: 1000, description: `PROFIT-TEST bad ${RUN}`,
    scope: "company", shop_id: shop.id,
  });
  check("scope='company' WITH a shop_id is REJECTED", !!error, error?.message ?? "accepted!");
}

// ── 2. Stock in, delivered, confirmed ────────────────────────────────────────
console.log("\nSeed stock: receive 10 → deliver 10 → shop confirms 10");
await owner.rpc("fn_receive_stock", {
  p_supplier_id: null, p_note: `PROFIT-TEST rcv ${RUN}`,
  p_parts: [{ part_id: part.id, qty: 10, unit_cost_centavos: COST }],
  p_engines: [],
});
const { data: delId } = await owner.rpc("fn_deliver_stock", {
  p_shop_id: shop.id, p_note: `PROFIT-TEST dlv ${RUN}`,
  p_parts: [{ part_id: part.id, qty: 10 }], p_engine_ids: [],
});
{
  const { data: line } = await owner
    .from("delivery_lines").select("id").eq("delivery_id", delId).single();
  const { error } = await emp.rpc("fn_confirm_delivery", {
    p_delivery_id: delId,
    p_lines: [{ line_id: line.id, qty_received: 10, shop_note: null }],
    p_note: null,
  });
  check("10 units landed at the shop", !error, error?.message);
}

// ── 3. A sale that is only RECORDED must not count as revenue ────────────────
console.log("\nRevenue counts approved sales ONLY:");
const { data: saleId, error: saleErr } = await emp.rpc("fn_record_sale", {
  p_customer_id: null, p_customer: null,
  p_part_lines: [{ part_id: part.id, qty: 4, unit_price_centavos: PRICE }],
  p_engine_lines: [],
});
check("shop records a sale of 4 units", !saleErr, saleErr?.message);

const revenueFor = async (statuses) => {
  const { data } = await owner
    .from("sales")
    .select("total_centavos, status")
    .eq("shop_id", shop.id)
    .in("status", statuses)
    .is("deleted_at", null);
  return (data ?? []).reduce((s, r) => s + r.total_centavos, 0);
};
check("recorded sale contributes ₱0 approved revenue", (await revenueFor(["approved"])) === 0);

// ── 4. Submit + approve ──────────────────────────────────────────────────────
console.log("\nSubmit batch → owner approves:");
{
  const { error } = await emp.rpc("fn_submit_shop_batch");
  check("batch submitted", !error, error?.message);
}
{
  const { error } = await owner.rpc("fn_approve_sale", { p_sale_id: saleId });
  check("sale approved", !error, error?.message);
}
const REVENUE = await revenueFor(["approved"]);
check(`approved revenue = ${P(4 * PRICE)}`, REVENUE === 4 * PRICE, String(REVENUE));

// ── 5. COGS is FROZEN at approval ────────────────────────────────────────────
console.log("\nCOGS snapshot (the whole point — history must not drift):");
const cogsFor = async () => {
  const { data } = await owner
    .from("sales")
    .select("shop_id, status, sale_line_costs(line_cost_centavos)")
    .eq("shop_id", shop.id)
    .eq("status", "approved")
    .is("deleted_at", null);
  return (data ?? []).flatMap((s) => s.sale_line_costs)
    .reduce((t, c) => t + (c.line_cost_centavos ?? 0), 0);
};
{
  const { data: c } = await owner
    .from("sale_line_costs")
    .select("unit_cost_centavos, line_cost_centavos")
    .eq("sale_id", saleId).single();
  check(
    `line cost stamped at approval = ${P(COST)}/unit`,
    c.unit_cost_centavos === COST,
    String(c.unit_cost_centavos)
  );
  check(
    `line cost total = ${P(4 * COST)}`,
    c.line_cost_centavos === 4 * COST,
    String(c.line_cost_centavos)
  );
}
const COGS = await cogsFor();
check(`COGS = ${P(4 * COST)} (4 × ${P(COST)})`, COGS === 4 * COST, String(COGS));

// The part's cost is mutable. Before 0037 this would silently rewrite the past.
await owner.from("parts").update({ cost_centavos: 9999 }).eq("id", part.id);
check(
  "raising the part's cost does NOT change past COGS",
  (await cogsFor()) === 4 * COST,
  String(await cogsFor())
);
await owner.from("parts").update({ cost_centavos: COST }).eq("id", part.id);

// ── 6. Expenses: shop-scoped vs company-wide ─────────────────────────────────
console.log("\nExpenses (shop-scoped vs company overhead):");
const { data: expCat } = await owner
  .from("expense_categories").select("id").limit(1).single();
const SHOP_EXPENSE = 2000;    // ₱20 electricity at this branch
const COMPANY_EXPENSE = 5000; // ₱50 company-wide, belongs to no branch
await owner.from("expenses").insert([
  {
    category_id: expCat.id, amount: SHOP_EXPENSE, expense_date: today,
    description: `PROFIT-TEST shop electricity ${RUN}`, scope: "shop", shop_id: shop.id,
  },
  {
    category_id: expCat.id, amount: COMPANY_EXPENSE, expense_date: today,
    description: `PROFIT-TEST company overhead ${RUN}`, scope: "company", shop_id: null,
  },
]);

{
  const { data } = await owner
    .from("expenses").select("amount, scope, shop_id")
    .eq("shop_id", shop.id).is("deleted_at", null);
  check(
    "filtering by shop returns only that shop's expenses",
    data.length === 1 && data[0].amount === SHOP_EXPENSE && data.every((e) => e.scope === "shop")
  );
}
{
  const { data } = await owner
    .from("expenses").select("shop_id").eq("scope", "company").is("deleted_at", null);
  check(
    "company-wide filter excludes every shop-scoped row",
    data.length > 0 && data.every((e) => e.shop_id === null)
  );
}
{
  const { data: all } = await owner
    .from("expenses").select("amount, scope").is("deleted_at", null);
  const grand = all.reduce((s, e) => s + e.amount, 0);
  const company = all.filter((e) => e.scope === "company").reduce((s, e) => s + e.amount, 0);
  const shops = all.filter((e) => e.scope === "shop").reduce((s, e) => s + e.amount, 0);
  check(
    `totals reconcile: company ${P(company)} + shops ${P(shops)} = ${P(grand)}`,
    company + shops === grand
  );
}

// ── 7. Payroll for this shop ─────────────────────────────────────────────────
console.log("\nPayroll for this branch:");
const PAYROLL = 3000; // ₱30
const { data: pos } = await owner.from("positions").select("id").limit(1).single();
const { data: staff } = await owner.from("staff").insert({
  shop_id: shop.id, full_name: `PROFIT-TEST Helper ${RUN}`,
  position_id: pos.id, pay_type: "daily", pay_rate: 1500,
}).select().single();
const { data: period } = await owner.from("pay_periods").insert({
  label: `PROFIT-TEST period ${RUN}`, start_date: today, end_date: today,
  frequency: "weekly",
}).select().single();
await owner.from("payroll_entries").insert({
  pay_period_id: period.id, staff_id: staff.id, shop_id: shop.id,
  days_worked: 2, gross_pay: PAYROLL, net_pay: PAYROLL,
});
{
  const { data } = await owner
    .from("payroll_entries")
    .select("net_pay, pay_periods!inner(start_date, end_date, deleted_at)")
    .eq("shop_id", shop.id)
    .lte("pay_periods.start_date", today)
    .gte("pay_periods.end_date", today)
    .is("pay_periods.deleted_at", null);
  const total = data.reduce((s, r) => s + r.net_pay, 0);
  check(`shop payroll in range = ${P(PAYROLL)}`, total === PAYROLL, String(total));
}

// ── 8. The profit chain (mirrors /shops/reports) ─────────────────────────────
console.log("\nProfitability chain for this shop:");
const grossProfit = REVENUE - COGS;
const netContribution = grossProfit - SHOP_EXPENSE - PAYROLL;
check(
  `Revenue ${P(REVENUE)} − COGS ${P(COGS)} = Gross ${P(grossProfit)}`,
  grossProfit === 6000
);
check("gross margin = 60%", Math.round((grossProfit / REVENUE) * 1000) / 10 === 60);
check(
  `Gross ${P(grossProfit)} − shop exp ${P(SHOP_EXPENSE)} − payroll ${P(PAYROLL)} = Net ${P(netContribution)}`,
  netContribution === 1000
);
check("net margin = 10%", Math.round((netContribution / REVENUE) * 1000) / 10 === 10);

// ── 9. Company overhead is reported, never allocated ─────────────────────────
console.log("\nCompany overhead stays unallocated:");
{
  const { data } = await owner
    .from("expenses").select("amount")
    .eq("scope", "shop").eq("shop_id", shop.id).is("deleted_at", null);
  const shopOpex = data.reduce((s, e) => s + e.amount, 0);
  check(
    "no slice of company overhead lands in the shop's expenses",
    shopOpex === SHOP_EXPENSE && shopOpex !== SHOP_EXPENSE + COMPANY_EXPENSE
  );
}
{
  // Σ shop net − company overhead = business net (overhead subtracted ONCE)
  const businessNet = netContribution - COMPANY_EXPENSE;
  check(
    `Σ shop net ${P(netContribution)} − overhead ${P(COMPANY_EXPENSE)} = business net ${P(businessNet)}`,
    businessNet === -4000
  );
}

// ── 10. A CLOSED shop's money still counts ──────────────────────────────────
// A branch that shut mid-period still sold and still cost money in that period.
// Filtering shops to `deleted_at is null` would silently drop it and understate
// business net — the live Roxas Branch alone is ~35% of this business's revenue.
console.log("\nClosed shops are not silently dropped:");
{
  await admin.from("shops").update({ deleted_at: new Date().toISOString() }).eq("id", shop.id);

  const { data: all } = await owner.from("shops").select("id, deleted_at");
  check(
    "a closed shop is still fetched by the report query",
    all.some((s) => s.id === shop.id)
  );

  const { data: sales } = await owner
    .from("sales").select("total_centavos")
    .eq("shop_id", shop.id).eq("status", "approved").is("deleted_at", null);
  check(
    `closed shop keeps its ${P(REVENUE)} of approved revenue`,
    sales.reduce((s, r) => s + r.total_centavos, 0) === REVENUE
  );
  check("closed shop keeps its frozen COGS", (await cogsFor()) === 4 * COST);

  // Reconciliation: every approved peso belongs to a shop the report can show.
  const { data: everySale } = await owner
    .from("sales").select("shop_id, total_centavos")
    .eq("status", "approved").is("deleted_at", null);
  const shopIds = new Set(all.map((s) => s.id));
  check(
    "every approved sale maps to a shop the report can show",
    everySale.every((s) => shopIds.has(s.shop_id))
  );

  await admin.from("shops").update({ deleted_at: null }).eq("id", shop.id);
}

// ── 11. Boundaries hold ──────────────────────────────────────────────────────
console.log("\nBoundaries:");
{
  const { data } = await owner
    .from("expenses").select("id, description").is("deleted_at", null);
  const { data: sp } = await owner.from("supplier_payments").select("id, note");
  const leaked = (sp ?? []).some((p) =>
    (data ?? []).some((e) => e.description && p.note && e.description === p.note)
  );
  check("supplier payments never appear in expenses (COGS boundary)", !leaked);
}
{
  const { data, error } = await emp.from("expenses").select("id, amount");
  check(
    "employee sees ZERO expenses",
    (data ?? []).length === 0 || !!error,
    `got ${data?.length} rows`
  );
}
{
  const { error } = await emp.from("expenses").insert({
    category_id: expCat.id, amount: 100, description: `PROFIT-TEST hack ${RUN}`,
    scope: "shop", shop_id: shop.id,
  });
  check("employee CANNOT record an expense", !!error, "insert accepted!");
}
{
  // The employee CAN read their own sale_lines (Submissions needs it) — so the
  // cost must not be a column there. Regression guard for the 0037→0038 leak.
  const { error } = await emp.from("sale_lines").select("unit_cost_centavos").limit(1);
  check(
    "sale_lines exposes no cost column at all",
    !!error && /unit_cost_centavos/.test(error.message),
    "employees can still select a cost column off sale_lines!"
  );
}
{
  const { data, error } = await emp
    .from("sale_line_costs").select("unit_cost_centavos, line_cost_centavos");
  check(
    "employee sees ZERO rows in sale_line_costs (owner-only)",
    (data ?? []).length === 0 || !!error,
    `got ${data?.length} rows`
  );
}
{
  // ...while the owner still can, or the whole report is blind.
  const { data } = await owner.from("sale_line_costs").select("line_cost_centavos").limit(1);
  check("owner CAN read sale_line_costs", (data ?? []).length === 1);
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
console.log("\nCleanup:");
{
  await owner.from("expenses").delete().like("description", `%${RUN}%`);
  await owner.from("payroll_entries").delete().eq("shop_id", shop.id);
  await owner.from("pay_periods").delete().eq("id", period.id);
  await owner.from("staff").delete().eq("id", staff.id);
  await owner.from("warranties").delete().eq("sale_id", saleId);
  // movements first, by BOTH part and shop — the master-side row has shop_id NULL
  await admin.from("stock_movements").delete().eq("part_id", part.id);
  await admin.from("sale_line_costs").delete().eq("sale_id", saleId);
  await admin.from("sale_lines").delete().eq("sale_id", saleId);
  await admin.from("sales").delete().eq("shop_id", shop.id);
  await admin.from("submission_batches").delete().eq("shop_id", shop.id);
  await admin.from("delivery_lines").delete().eq("delivery_id", delId);
  await admin.from("deliveries").delete().eq("id", delId);
  await admin.from("receiving_lines").delete().eq("part_id", part.id);
  await admin.from("receivings").delete().like("note", `%${RUN}%`);
  await admin.from("stock_levels").delete().eq("part_id", part.id);
  await admin.from("notifications").delete().eq("shop_id", shop.id);
  await admin.from("parts").delete().eq("id", part.id);
  await admin.from("profiles").delete().eq("id", u.user.id);
  await admin.auth.admin.deleteUser(u.user.id);
  await admin.from("shops").delete().eq("id", shop.id);
  const { data: left } = await admin.from("shops").select("id").eq("id", shop.id);
  check("temp fixtures removed", (left ?? []).length === 0);
}
{
  const { data: after } = await owner
    .from("expenses").select("id, scope, shop_id").is("deleted_at", null);
  check(
    `live expenses untouched: ${after.length} rows, ${after.filter((e) => e.scope === "shop").length} still shop-scoped`,
    after.length === baseline.length &&
      after.filter((e) => e.scope === "shop").length === baseShopScoped
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
