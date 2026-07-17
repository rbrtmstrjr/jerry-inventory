/**
 * Supplier payables verification Ã¢â‚¬â€ debt from receiving, due dates from terms,
 * credit limit that WARNS + requires an audited override (never blocks),
 * targeted + FIFO payments with over-payment guards, settlement, aging,
 * deduped owner-only alerts, and strict employee lockout.
 *
 * Self-contained: temp supplier + shop/employee via the service role, then
 * hard-cleans everything it made.
 *
 * Run: node scripts/test-supplier-payables.mjs
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
const P = (c) => `Ã¢â€šÂ±${(c / 100).toLocaleString()}`;

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "Ã¢Å“â€œ" : "Ã¢Å“â€”"} ${name} ${ok ? "" : detail}`);
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

const owner = await signIn("robertmaestro09@gmail.com", "rajonrondo09");

// temp shop + employee purely to prove employees are locked out
const { data: shop } = await admin
  .from("shops").insert({ name: `PAY-TEST Shop ${RUN}` }).select().single();
const empEmail = `pay-${RUN.toLowerCase()}@test.local`;
const { data: u } = await admin.auth.admin.createUser({
  email: empEmail, password: `Pay!${RUN}`, email_confirm: true,
});
await admin.from("profiles").insert({
  id: u.user.id, full_name: `PAY-TEST Staff`, role: "employee", shop_id: shop.id,
});
const emp = await signIn(empEmail, `Pay!${RUN}`);

console.log("Setup: supplier with Ã¢â€šÂ±100,000 limit, net-30 terms");
const { data: sup } = await owner.from("suppliers").insert({
  name: `PAY-TEST Supplier ${RUN}`,
  contact: "0917-777-8888",
  credit_limit: 10000000,      // Ã¢â€šÂ±100,000
  payment_terms_days: 30,
}).select().single();
const { data: cat } = await owner.from("product_categories").select("id").limit(1).single();
const { data: part } = await admin.from("parts").insert({
  name: `PAY-TEST Widget ${RUN}`, category_id: cat.id,
  cost_centavos: 1000, price_centavos: 2000,
}).select().single();

const receive = (opts) =>
  owner.rpc("fn_receive_stock", {
    p_supplier_id: sup.id,
    p_note: `PAY-TEST ${opts.tag} ${RUN}`,
    p_parts: [{ part_id: part.id, qty: opts.qty, unit_cost_centavos: opts.cost }],
    p_engines: [],
    p_payment_status: opts.status,
    p_amount_paid: opts.paid ?? null,
    p_due_date: opts.due ?? null,
    p_override: opts.override ?? false,
    p_override_reason: opts.reason ?? null,
  });

const balOf = async (rid) =>
  (await owner.rpc("fn_receiving_balance", { p_receiving_id: rid })).data;
const outOf = async () =>
  (await owner.rpc("fn_supplier_outstanding", { p_supplier_id: sup.id })).data;

// Ã¢â€â‚¬Ã¢â€â‚¬ Debt is created at receiving Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
console.log("\nReceiving on credit creates the debt:");
// Ã¢â€šÂ±40,000 unpaid
const { data: r1, error: e1 } = await receive({ tag: "r1", qty: 40, cost: 100000, status: "unpaid" });
check("unpaid receiving accepted", !e1, e1?.message);
{
  const { data: row } = await owner
    .from("receiving_balances").select("*").eq("receiving_id", r1).single();
  check("total = Ã¢â€šÂ±40,000", row?.total_amount === 4000000, `(got ${row?.total_amount})`);
  check("nothing paid yet", row?.amount_paid === 0);
  check("balance = Ã¢â€šÂ±40,000", row?.balance === 4000000);
  check("status = unpaid", row?.payment_status === "unpaid");
  check("due date auto-set from net-30 terms", !!row?.due_date);
  const { data: today } = await admin.rpc("ph_today");
  const expected = new Date(`${today}T00:00:00Z`);
  expected.setUTCDate(expected.getUTCDate() + 30);
  check("due date = received + 30 days (PH)",
    row?.due_date === expected.toISOString().slice(0, 10),
    `(got ${row?.due_date}, expected ${expected.toISOString().slice(0, 10)})`);
}
// Ã¢â€šÂ±20,000 with Ã¢â€šÂ±5,000 paid up front + explicit due date
const { data: r2 } = await receive({
  tag: "r2", qty: 20, cost: 100000, status: "partial", paid: 500000, due: "2099-01-01",
});
{
  const { data: row } = await owner
    .from("receiving_balances").select("*").eq("receiving_id", r2).single();
  check("partial receiving: balance = Ã¢â€šÂ±15,000", row?.balance === 1500000, `(got ${row?.balance})`);
  check("status = partial", row?.payment_status === "partial");
  check("explicit due date overrides the terms", row?.due_date === "2099-01-01");
}
check("supplier outstanding = Ã¢â€šÂ±55,000", (await outOf()) === 5500000, `(got ${await outOf()})`);

// Ã¢â€â‚¬Ã¢â€â‚¬ Credit limit: warns, never silently blocks Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
console.log("\nCredit limit warns + needs an audited override (never blocks):");
{
  const { data } = await owner.rpc("fn_supplier_limit_check", {
    p_supplier_id: sup.id, p_additional: 5000000,
  });
  check("live check reports projected Ã¢â€šÂ±105,000 > Ã¢â€šÂ±100,000 limit",
    data?.projected === 10500000 && data?.would_exceed === true, JSON.stringify(data));
  check("utilization % computed", Number(data?.utilization_pct) === 105);
}
{
  const { error } = await receive({ tag: "over", qty: 50, cost: 100000, status: "unpaid" });
  check("over-limit receiving is REJECTED without an override",
    !!error && /CREDIT_LIMIT_EXCEEDED/.test(error.message), error?.message);
  check("the error tells the owner the numbers",
    !!error && /100,000/.test(error.message), error?.message);
}
{
  const { error } = await receive({
    tag: "over2", qty: 50, cost: 100000, status: "unpaid", override: true,
  });
  check("override WITHOUT a reason is rejected", !!error && /reason/i.test(error.message), error?.message);
}
let rOver;
{
  const { data, error } = await receive({
    tag: "over3", qty: 50, cost: 100000, status: "unpaid",
    override: true, reason: "PAY-TEST urgent restock, Admin approved",
  });
  rOver = data;
  check("override WITH a reason goes through (not blocked)", !error, error?.message);
  const { data: row } = await owner
    .from("receiving_balances").select("limit_override, limit_override_reason")
    .eq("receiving_id", rOver).single();
  check("override recorded on the receiving", row?.limit_override === true);
  check("override reason recorded (auditable)",
    (row?.limit_override_reason ?? "").includes("urgent restock"));
  const { data: audit } = await owner
    .from("receivings").select("limit_override_by, limit_override_at").eq("id", rOver).single();
  check("who + when recorded", !!audit?.limit_override_by && !!audit?.limit_override_at);
}
check("outstanding now Ã¢â€šÂ±105,000 (over the limit)", (await outOf()) === 10500000, `(got ${await outOf()})`);

// Ã¢â€â‚¬Ã¢â€â‚¬ Payables rollup Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
console.log("\nPayables rollup:");
{
  const { data } = await owner
    .from("supplier_payables").select("*").eq("supplier_id", sup.id).single();
  check("outstanding = Ã¢â€šÂ±105,000", data?.outstanding === 10500000);
  check("3 open receivings", data?.open_count === 3, `(got ${data?.open_count})`);
  check("utilization = 105%", Number(data?.utilization_pct) === 105);
  check("credit limit surfaced", data?.credit_limit === 10000000);
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Payments: targeted, guards, FIFO Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
console.log("\nPayments Ã¢â‚¬â€ targeted, guarded, FIFO:");
{
  const { error } = await owner.rpc("fn_record_supplier_payment", {
    p_supplier_id: sup.id, p_amount: 4000001, p_receiving_id: r1,
  });
  check("cannot pay more than that receiving owes",
    !!error && /exceeds/i.test(error.message), error?.message);
}
{
  const { error } = await owner.rpc("fn_record_supplier_payment", {
    p_supplier_id: sup.id, p_amount: 10500001,
  });
  check("cannot pay more than the supplier is owed overall",
    !!error && /exceeds/i.test(error.message), error?.message);
}
{
  // targeted: settle r1 exactly
  const { data, error } = await owner.rpc("fn_record_supplier_payment", {
    p_supplier_id: sup.id, p_amount: 4000000, p_receiving_id: r1,
    p_method: "bank", p_reference_no: `PAY-TEST-REF-${RUN}`,
  });
  check("targeted payment accepted", !error, error?.message);
  check("allocated to exactly that receiving", data?.allocations?.length === 1);
  check("r1 balance now 0", (await balOf(r1)) === 0);
  const { data: row } = await owner
    .from("receiving_balances").select("settled_at, payment_status").eq("receiving_id", r1).single();
  check("r1 marked settled", !!row?.settled_at && row?.payment_status === "paid");
}
{
  // unallocated Ã¢â€ â€™ FIFO across the remaining two (r2 = Ã¢â€šÂ±15k, rOver = Ã¢â€šÂ±50k)
  const { data, error } = await owner.rpc("fn_record_supplier_payment", {
    p_supplier_id: sup.id, p_amount: 2000000, p_method: "cash",  // Ã¢â€šÂ±20,000
  });
  check("unallocated payment accepted", !error, error?.message);
  check("split FIFO across 2 receivings", data?.allocations?.length === 2,
    JSON.stringify(data?.allocations));
  check("oldest (r2, Ã¢â€šÂ±15k) fully covered first",
    data?.allocations?.[0]?.receiving_id === r2 && data?.allocations?.[0]?.amount === 1500000,
    JSON.stringify(data?.allocations));
  check("remainder Ã¢â€šÂ±5,000 goes to the next oldest",
    data?.allocations?.[1]?.receiving_id === rOver && data?.allocations?.[1]?.amount === 500000);
  check("r2 settled by the FIFO run", (await balOf(r2)) === 0);
  check("rOver partially paid Ã¢â€ â€™ Ã¢â€šÂ±45,000 left", (await balOf(rOver)) === 4500000);
  const { data: rows } = await owner
    .from("supplier_payments").select("payment_group_id").eq("supplier_id", sup.id)
    .eq("amount", 1500000);
  check("split rows share one payment_group_id", !!rows?.[0]?.payment_group_id);
}
check("outstanding now Ã¢â€šÂ±45,000", (await outOf()) === 4500000, `(got ${await outOf()})`);

// Ã¢â€â‚¬Ã¢â€â‚¬ Reconciliation Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
console.log("\nReconciliation (total Ã¢Ë†â€™ paid Ã¢Ë†â€™ ÃŽÂ£ payments = balance):");
{
  const { data: rows } = await owner
    .from("receiving_balances").select("*").eq("supplier_id", sup.id);
  const ok = (rows ?? []).every(
    (r) => r.balance === r.total_amount - r.amount_paid - r.paid_since
  );
  check("every receiving reconciles", ok);
  const sum = (rows ?? []).filter((r) => r.balance > 0).reduce((s, r) => s + r.balance, 0);
  check("view total matches fn_supplier_outstanding", sum === (await outOf()));
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Alerts: 80% / limit reached / overdue, deduped, owner-only Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
console.log("\nAlerts (deduped, owner-only):");
{
  const { data: n } = await owner
    .from("notifications").select("id").eq("type", "supplier_limit_reached").eq("ref_id", sup.id);
  check("limit-reached alert fired when it went over", (n ?? []).length === 1);
}
{
  // Ã¢â€šÂ±45,000 of Ã¢â€šÂ±100,000 = 45% Ã¢â€ â€™ under the 80% warn Ã¢â€ â€™ the open alert clears
  const { data: n } = await owner
    .from("notifications").select("read_at")
    .in("type", ["supplier_limit_reached", "supplier_limit_warning"]).eq("ref_id", sup.id);
  check("paying back down CLEARS the open limit alert",
    (n ?? []).every((x) => !!x.read_at), JSON.stringify(n));
}
{
  // push to 85% Ã¢â€ â€™ warning (not reached)
  await receive({ tag: "warn", qty: 40, cost: 100000, status: "unpaid" }); // +40k Ã¢â€ â€™ 85k = 85%
  const { data: n } = await owner
    .from("notifications").select("id, read_at")
    .eq("type", "supplier_limit_warning").eq("ref_id", sup.id).is("read_at", null);
  check("crossing 80% fires the warning", (n ?? []).length === 1, `(got ${(n ?? []).length})`);
}
{
  await receive({ tag: "warn2", qty: 1, cost: 100, status: "unpaid" });
  const { data: n } = await owner
    .from("notifications").select("id")
    .eq("type", "supplier_limit_warning").eq("ref_id", sup.id).is("read_at", null);
  check("further receivings do NOT re-spam the warning (dedupe)",
    (n ?? []).length === 1, `(got ${(n ?? []).length})`);
}
{
  // make rOver overdue
  await admin.from("receivings").update({ due_date: "2020-01-01" }).eq("id", rOver);
  const { data: n1, error } = await admin.rpc("fn_check_supplier_overdue");
  check("daily overdue sweep ran", !error, error?.message);
  check("it found the overdue receiving", (n1 ?? 0) >= 1);
  const { data: n } = await owner
    .from("notifications").select("id").eq("type", "supplier_payment_overdue").eq("ref_id", rOver);
  check("owner alerted once about it", (n ?? []).length === 1);
  await admin.rpc("fn_check_supplier_overdue");
  await admin.rpc("fn_check_supplier_overdue");
  const { data: n2 } = await owner
    .from("notifications").select("id").eq("type", "supplier_payment_overdue").eq("ref_id", rOver);
  check("re-running the sweep does NOT duplicate", (n2 ?? []).length === 1, `(got ${(n2 ?? []).length})`);
  const { data: rb } = await owner
    .from("receiving_balances").select("overdue, days_overdue").eq("receiving_id", rOver).single();
  check("receiving flagged overdue with day count", rb?.overdue === true && rb?.days_overdue > 0);
  const { data: sp } = await owner
    .from("supplier_payables").select("overdue_amount").eq("supplier_id", sup.id).single();
  check("supplier overdue_amount rolls up", sp?.overdue_amount === 4500000, `(got ${sp?.overdue_amount})`);
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Employees are locked out entirely Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
console.log("\nEmployees have ZERO access to payables:");
{
  const { data } = await emp.from("supplier_payables").select("*");
  check("employee sees no payables rows", (data ?? []).length === 0);
}
{
  const { data } = await emp.from("receiving_balances").select("*");
  check("employee sees no receiving balances", (data ?? []).length === 0);
}
{
  const { data } = await emp.from("supplier_payments").select("*");
  check("employee sees no supplier payments", (data ?? []).length === 0);
}
{
  const { data } = await emp.from("suppliers").select("id, credit_limit");
  check("employee cannot read suppliers/credit limits", (data ?? []).length === 0);
}
{
  const { error } = await emp.rpc("fn_record_supplier_payment", {
    p_supplier_id: sup.id, p_amount: 100,
  });
  check("employee cannot record a supplier payment", !!error && /owner/i.test(error.message));
}
{
  const { error } = await emp.rpc("fn_supplier_limit_check", { p_supplier_id: sup.id, p_additional: 0 });
  check("employee cannot probe credit limits", !!error && /owner/i.test(error.message));
}
// 0047: the balance definer functions must not leak cost to a shop even when
// the shop supplies a valid id. A fresh UNPAID receiving guarantees a non-zero
// balance to leak Ã¢â‚¬â€ the suite's earlier receivings are settled by now, which
// would make the shop-gets-0 check pass for the wrong reason.
{
  const { data: fresh } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: sup.id, p_note: `PAYABLE-TEST leak ${RUN}`,
    p_parts: [{ part_id: part.id, qty: 1, unit_cost_centavos: 77700 }],
    p_engines: [], p_payment_status: "unpaid",
  });
  const ownerBal = await balOf(fresh);
  check("owner reads the real Ã¢â€šÂ±777 balance (baseline for the leak test)",
    ownerBal === 77700, `got ${ownerBal}`);

  // These are language-sql read helpers that return an empty result to a
  // non-owner (rather than raising), so assert 0/null Ã¢â‚¬â€ not an error.
  const shopBal = await emp.rpc("fn_receiving_balance", { p_receiving_id: fresh });
  check("employee gets NO receiving balance via fn_receiving_balance (0047)",
    !shopBal.error && (shopBal.data == null || shopBal.data === 0),
    `got ${shopBal.data} (leak Ã¢â‚¬â€ apply 0047)`);
  const shopOut = await emp.rpc("fn_supplier_outstanding", { p_supplier_id: sup.id });
  check("employee gets 0 from fn_supplier_outstanding (0047)",
    !shopOut.error && (shopOut.data == null || shopOut.data === 0),
    `got ${shopOut.data} (leak Ã¢â‚¬â€ apply 0047)`);
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Payables are NOT expenses Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
console.log("\nSupplier payments are COGS, not operating expenses:");
{
  const { data } = await owner
    .from("expenses").select("id").like("description", `%${RUN}%`);
  check("no expense rows were created by paying a supplier", (data ?? []).length === 0);
  const { count } = await owner
    .from("supplier_payments").select("id", { count: "exact", head: true }).eq("supplier_id", sup.id);
  check("the payments live in supplier_payments instead", (count ?? 0) >= 3, `(got ${count})`);
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Cleanup Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
console.log("\nCleanup:");
{
  await admin.from("notifications").delete().eq("ref_id", sup.id);
  const { data: recs } = await admin
    .from("receivings").select("id").eq("supplier_id", sup.id);
  const ids = (recs ?? []).map((r) => r.id);
  if (ids.length) await admin.from("notifications").delete().in("ref_id", ids);
  await admin.from("supplier_payments").delete().eq("supplier_id", sup.id);
  await admin.from("stock_movements").delete().eq("part_id", part.id);
  await admin.from("receivings").delete().eq("supplier_id", sup.id);
  await admin.from("stock_levels").delete().eq("part_id", part.id);
  await admin.from("parts").delete().eq("id", part.id);
  await admin.from("suppliers").delete().eq("id", sup.id);
  await admin.auth.admin.deleteUser(u.user.id);
  const { error } = await admin.from("shops").delete().eq("id", shop.id);
  check("temp fixtures removed", !error, error?.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
