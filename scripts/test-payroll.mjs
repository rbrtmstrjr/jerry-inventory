/**
 * Payroll verification — owner-only RLS, gross computation (daily + monthly
 * proration), approve → paid flow, finalize immutability, paid-line immutability.
 * Run: node scripts/test-payroll.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);

const SHOP1 = "a0000000-0000-4000-8000-000000000001";
const SHOP2 = "a0000000-0000-4000-8000-000000000002";
const RUN = Date.now().toString(36).toUpperCase();

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name} ${ok ? "" : detail}`);
  ok ? pass++ : fail++;
};

async function signIn(email, password) {
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return c;
}

const owner = await signIn("owner@jerrysmarine.test", "Owner!Dev2026");
const emp1 = await signIn("branch1@jerrysmarine.test", "Branch1!Dev2026");

console.log("RLS: regular employee is locked out of ALL payroll tables:");
for (const table of ["positions", "staff", "pay_periods", "payroll_entries"]) {
  const { data } = await emp1.from(table).select("*").limit(5);
  check(`employee reads nothing from ${table}`, (data ?? []).length === 0);
}
{
  const { error } = await emp1.rpc("fn_create_pay_period", {
    p_label: "sneaky", p_start: "2026-07-01", p_end: "2026-07-15", p_frequency: "semi_monthly",
  });
  check("employee cannot create pay periods", !!error && /owner/i.test(error.message));
}
{
  const { error } = await emp1.from("staff").insert({
    shop_id: SHOP1, full_name: "Sneaky Hire", pay_rate: 1,
  });
  check("employee cannot insert staff", !!error);
}

console.log("\nSetup: position + daily & monthly staff:");
const { data: pos } = await owner
  .from("positions")
  .insert({ title: `PAY-TEST Helper ${RUN}`, shop_id: null, default_pay_rate: 40000 })
  .select().single();
check("custom position created", !!pos);

const { data: daily } = await owner.from("staff")
  .insert({ full_name: `PAY-TEST Daily ${RUN}`, shop_id: SHOP1, position_id: pos.id, pay_type: "daily", pay_rate: 50000 })
  .select().single();
const { data: monthly } = await owner.from("staff")
  .insert({ full_name: `PAY-TEST Monthly ${RUN}`, shop_id: SHOP2, position_id: pos.id, pay_type: "monthly", pay_rate: 1500000 })
  .select().single();
check("daily (₱500/day) + monthly (₱15,000/mo) staff created", !!daily && !!monthly);

console.log("\nCreate semi-monthly period:");
const { data: periodId, error: cpErr } = await owner.rpc("fn_create_pay_period", {
  p_label: `PAY-TEST Jul 1–15 ${RUN}`, p_start: "2026-07-01", p_end: "2026-07-15", p_frequency: "semi_monthly",
});
check("period created with entries", !cpErr, cpErr?.message);

const entriesOf = async () =>
  (await owner.from("payroll_entries")
    .select("id, staff_id, days_worked, gross_pay, net_pay, status, date_paid")
    .eq("pay_period_id", periodId)).data ?? [];

let entries = await entriesOf();
const dailyEntry = entries.find((e) => e.staff_id === daily.id);
const monthlyEntry = entries.find((e) => e.staff_id === monthly.id);
check("entries include both new staff", !!dailyEntry && !!monthlyEntry);
check("monthly semi-monthly proration: ₱15,000 ÷ 2 = ₱7,500", monthlyEntry?.gross_pay === 750000, `(got ${monthlyEntry?.gross_pay})`);
check("daily starts at 0 days / ₱0", dailyEntry?.gross_pay === 0 && Number(dailyEntry?.days_worked) === 0);

console.log("\nDays worked → gross:");
{
  const { error } = await owner.rpc("fn_save_payroll_days", {
    p_period_id: periodId,
    p_lines: [{ entry_id: dailyEntry.id, days_worked: 10 }],
  });
  check("days saved", !error, error?.message);
  entries = await entriesOf();
  const d = entries.find((e) => e.id === dailyEntry.id);
  check("daily gross = ₱500 × 10 = ₱5,000", d?.gross_pay === 500000 && d?.net_pay === 500000, `(got ${d?.gross_pay})`);
}

console.log("\nApprove → pay:");
{
  const { data: n, error } = await owner.rpc("fn_approve_pay_period", { p_period_id: periodId });
  check(`approve marks drafts approved (${n})`, !error && n >= 2, error?.message);
}
{
  const { data: n, error } = await owner.rpc("fn_mark_payroll_paid", {
    p_period_id: periodId, p_entry_ids: [], p_all: true,
  });
  check(`mark-all-paid pays ${n} entries`, !error && n >= 2, error?.message);
  entries = await entriesOf();
  check("date_paid stamped", entries.every((e) => e.status !== "paid" || !!e.date_paid));
}

console.log("\nFinalize locks everything:");
{
  const { error } = await owner.rpc("fn_set_pay_period_status", { p_period_id: periodId, p_finalize: true });
  check("finalized", !error, error?.message);
}
{
  const { error } = await owner.rpc("fn_save_payroll_days", {
    p_period_id: periodId, p_lines: [{ entry_id: dailyEntry.id, days_worked: 15 }],
  });
  check("save days on finalized period rejected", !!error && /finalized/i.test(error.message));
}
{
  const { error } = await owner.rpc("fn_mark_payroll_paid", { p_period_id: periodId, p_entry_ids: [], p_all: true });
  check("marking paid on finalized period rejected", !!error && /finalized/i.test(error.message));
}
{
  const { error } = await owner.rpc("fn_set_pay_period_status", { p_period_id: periodId, p_finalize: false });
  check("reopen works", !error, error?.message);
  // paid lines stay immutable even when the period is open
  await owner.rpc("fn_save_payroll_days", {
    p_period_id: periodId, p_lines: [{ entry_id: dailyEntry.id, days_worked: 15 }],
  });
  entries = await entriesOf();
  const d = entries.find((e) => e.id === dailyEntry.id);
  check("PAID line unchanged despite edit attempt (still ₱5,000)", d?.gross_pay === 500000);
}

console.log("\nProration rules on other frequencies:");
const { data: pmId } = await owner.rpc("fn_create_pay_period", {
  p_label: `PAY-TEST July full ${RUN}`, p_start: "2026-07-01", p_end: "2026-07-31", p_frequency: "monthly",
});
const { data: pwId } = await owner.rpc("fn_create_pay_period", {
  p_label: `PAY-TEST wk1 ${RUN}`, p_start: "2026-07-01", p_end: "2026-07-07", p_frequency: "weekly",
});
{
  const { data } = await owner.from("payroll_entries")
    .select("gross_pay").eq("pay_period_id", pmId).eq("staff_id", monthly.id).single();
  check("monthly frequency → full ₱15,000", data?.gross_pay === 1500000, `(got ${data?.gross_pay})`);
}
{
  const { data } = await owner.from("payroll_entries")
    .select("gross_pay").eq("pay_period_id", pwId).eq("staff_id", monthly.id).single();
  check("weekly frequency → ₱15,000 ÷ 4 = ₱3,750", data?.gross_pay === 375000, `(got ${data?.gross_pay})`);
}

console.log("\nCleanup:");
{
  const now = new Date().toISOString();
  const r1 = await owner.from("pay_periods").update({ deleted_at: now }).in("id", [periodId, pmId, pwId]);
  const r2 = await owner.from("staff").update({ deleted_at: now, active: false }).in("id", [daily.id, monthly.id]);
  const r3 = await owner.from("positions").update({ deleted_at: now, active: false }).eq("id", pos.id);
  const err = r1.error ?? r2.error ?? r3.error;
  check("fixtures soft-deleted (history preserved)", !err, err?.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
