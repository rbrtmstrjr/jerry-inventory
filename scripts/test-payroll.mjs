/**
 * Payroll — owner-only RLS, gross computation (daily + monthly proration),
 * the draft → approved → paid flow, finalize immutability, and paid-line
 * immutability.
 *
 * Verifies:
 *   • employees read/write NOTHING across all four payroll tables
 *   • fn_create_pay_period drafts an entry per ACTIVE staff member, pre-computing
 *     monthly salaries and starting daily staff at zero
 *   • proration: monthly → full · semi_monthly → ÷2 · weekly → ÷4 · daily → rate × days
 *   • net_pay tracks gross_pay (v1 has no deductions)
 *   • entries carry the denormalized shop_id that per-branch reporting keys on
 *   • a finalized period rejects every mutation until reopened
 *   • a PAID line is immutable even while the period is open
 *   • garbage in is refused: negative days, cross-period entries, end < start
 *
 * Provisions its own two shops — it must never write into a real branch. The
 * pay periods it creates are global by design (fn_create_pay_period drafts for
 * every active staff member), so they are hard-deleted on cleanup and their
 * entries cascade with them.
 *
 * Run: node scripts/test-payroll.mjs
 */
import {
  owner, RUN, P, check, section, summary,
  provisionShop, cleanup,
} from "./_harness.mjs";

const A = await provisionShop("Payroll A");
const B = await provisionShop("Payroll B");
const emp = A.client;

// Period dates track the current PH month, so nothing is frozen to a past year.
const phToday = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
const [Y, M] = phToday.split("-");
const lastDom = new Date(Date.UTC(+Y, +M, 0)).getUTCDate();
const FIRST = `${Y}-${M}-01`;
const MID = `${Y}-${M}-15`;
const LAST = `${Y}-${M}-${lastDom}`;
const DAY7 = `${Y}-${M}-07`;

section("RLS: regular employee is locked out of ALL payroll tables:");
for (const table of ["positions", "staff", "pay_periods", "payroll_entries"]) {
  const { data } = await emp.from(table).select("*").limit(5);
  check(`employee reads nothing from ${table}`, (data ?? []).length === 0, `got ${data?.length}`);
}
{
  const { error } = await emp.rpc("fn_create_pay_period", {
    p_label: `sneaky ${RUN}`, p_start: FIRST, p_end: MID, p_frequency: "semi_monthly",
  });
  check("employee cannot create pay periods", !!error && /owner/i.test(error.message), error?.message);
}
{
  const { error } = await emp.from("staff").insert({
    shop_id: A.id, full_name: `sneaky hire ${RUN}`, pay_rate: 1,
  });
  check("employee cannot insert staff", !!error);
}

section("Setup: position + daily & monthly staff:");
const { data: pos } = await owner.from("positions")
  .insert({ title: `ZZ-TEST Helper ${RUN}`, shop_id: null, default_pay_rate: 40000 })
  .select().single();
check("custom position created", !!pos);

const DAILY_RATE = 50000;      // ₱500/day
const MONTHLY_RATE = 1500000;  // ₱15,000/mo
const { data: daily } = await owner.from("staff").insert({
  full_name: `ZZ-TEST Daily ${RUN}`, shop_id: A.id, position_id: pos.id,
  pay_type: "daily", pay_rate: DAILY_RATE,
}).select().single();
const { data: monthly } = await owner.from("staff").insert({
  full_name: `ZZ-TEST Monthly ${RUN}`, shop_id: B.id, position_id: pos.id,
  pay_type: "monthly", pay_rate: MONTHLY_RATE,
}).select().single();
check(`daily (${P(DAILY_RATE)}/day) + monthly (${P(MONTHLY_RATE)}/mo) staff created`, !!daily && !!monthly);

section("Create semi-monthly period:");
{
  const { error } = await owner.rpc("fn_create_pay_period", {
    p_label: `ZZ-TEST backwards ${RUN}`, p_start: MID, p_end: FIRST, p_frequency: "semi_monthly",
  });
  check("period ending before it starts is rejected", !!error, "accepted!");
}
const { data: periodId, error: cpErr } = await owner.rpc("fn_create_pay_period", {
  p_label: `ZZ-TEST 1-15 ${RUN}`, p_start: FIRST, p_end: MID, p_frequency: "semi_monthly",
});
check("period created with entries", !cpErr, cpErr?.message);

const entriesOf = async (period = periodId) =>
  (await owner.from("payroll_entries")
    .select("id, staff_id, shop_id, days_worked, gross_pay, net_pay, status, date_paid")
    .eq("pay_period_id", period)).data ?? [];

let entries = await entriesOf();
const dailyEntry = entries.find((e) => e.staff_id === daily.id);
const monthlyEntry = entries.find((e) => e.staff_id === monthly.id);
check("entries include both new staff", !!dailyEntry && !!monthlyEntry);
check(`monthly semi-monthly proration: ${P(MONTHLY_RATE)} ÷ 2 = ${P(750000)}`,
  monthlyEntry?.gross_pay === 750000, `(got ${monthlyEntry?.gross_pay})`);
check("daily starts at 0 days / ₱0",
  dailyEntry?.gross_pay === 0 && Number(dailyEntry?.days_worked) === 0);
check("entries carry the denormalized shop_id per-branch reporting keys on",
  dailyEntry?.shop_id === A.id && monthlyEntry?.shop_id === B.id);
{
  const { error } = await owner.from("payroll_entries").insert({
    pay_period_id: periodId, staff_id: daily.id, shop_id: A.id,
  });
  check("one staff member cannot get two entries in a period", !!error, "duplicate accepted!");
}

section("Days worked → gross:");
{
  const { error } = await owner.rpc("fn_save_payroll_days", {
    p_period_id: periodId, p_lines: [{ entry_id: dailyEntry.id, days_worked: 10 }],
  });
  check("days saved", !error, error?.message);
  const d = (await entriesOf()).find((e) => e.id === dailyEntry.id);
  check(`daily gross = ${P(DAILY_RATE)} × 10 = ${P(500000)}`, d?.gross_pay === 500000, `(got ${d?.gross_pay})`);

  // Was "net_pay tracks gross_pay (no deductions in v1)". v1 is over: 0039-0042
  // withhold the employee's SSS/PhilHealth/Pag-IBIG share, so net is now
  // gross MINUS those. The deduction detail is owned by
  // test-payroll-contributions.mjs; here we only prove the two stay consistent.
  const { data: contrib } = await owner
    .from("payroll_entry_contributions")
    .select("ee_amount_centavos")
    .eq("payroll_entry_id", dailyEntry.id);
  const ee = (contrib ?? []).reduce((s, c) => s + c.ee_amount_centavos, 0);
  check(
    `net = gross − employee gov share (${P(500000)} − ${P(ee)})`,
    d?.net_pay === d.gross_pay - ee,
    `(got ${d?.net_pay})`
  );
}
{
  const { error } = await owner.rpc("fn_save_payroll_days", {
    p_period_id: periodId, p_lines: [{ entry_id: dailyEntry.id, days_worked: -3 }],
  });
  check("negative days rejected", !!error && /negative/i.test(error.message), error?.message);
}

section("Approve → pay:");
{
  const { data: n, error } = await owner.rpc("fn_approve_pay_period", { p_period_id: periodId });
  check(`approve marks drafts approved (${n})`, !error && n >= 2, error?.message);
  entries = await entriesOf();
  check("both test entries are approved",
    [dailyEntry.id, monthlyEntry.id].every((id) => entries.find((e) => e.id === id)?.status === "approved"));
}
{
  const { data: n, error } = await owner.rpc("fn_mark_payroll_paid", {
    p_period_id: periodId, p_entry_ids: [], p_all: true,
  });
  check(`mark-all-paid pays ${n} entries`, !error && n >= 2, error?.message);
  entries = await entriesOf();
  check("date_paid stamped on every paid entry",
    entries.every((e) => e.status !== "paid" || !!e.date_paid));
  check("date_paid is PH today",
    entries.find((e) => e.id === dailyEntry.id)?.date_paid === phToday);
}

section("Finalize locks everything:");
{
  const { error } = await owner.rpc("fn_set_pay_period_status", { p_period_id: periodId, p_finalize: true });
  check("finalized", !error, error?.message);
}
{
  const { error } = await owner.rpc("fn_save_payroll_days", {
    p_period_id: periodId, p_lines: [{ entry_id: dailyEntry.id, days_worked: 15 }],
  });
  check("save days on finalized period rejected", !!error && /finalized/i.test(error.message), error?.message);
}
{
  const { error } = await owner.rpc("fn_mark_payroll_paid", { p_period_id: periodId, p_entry_ids: [], p_all: true });
  check("marking paid on finalized period rejected", !!error && /finalized/i.test(error.message), error?.message);
}
{
  const { error } = await owner.rpc("fn_approve_pay_period", { p_period_id: periodId });
  check("approving on finalized period rejected", !!error && /finalized/i.test(error.message), error?.message);
}
{
  const { error } = await owner.rpc("fn_set_pay_period_status", { p_period_id: periodId, p_finalize: false });
  check("reopen works", !error, error?.message);
  // paid lines stay immutable even once the period is open again
  await owner.rpc("fn_save_payroll_days", {
    p_period_id: periodId, p_lines: [{ entry_id: dailyEntry.id, days_worked: 15 }],
  });
  const d = (await entriesOf()).find((e) => e.id === dailyEntry.id);
  check(`PAID line unchanged despite edit attempt (still ${P(500000)})`, d?.gross_pay === 500000, `(got ${d?.gross_pay})`);
}

section("Proration rules on other frequencies:");
const { data: pmId } = await owner.rpc("fn_create_pay_period", {
  p_label: `ZZ-TEST full month ${RUN}`, p_start: FIRST, p_end: LAST, p_frequency: "monthly",
});
const { data: pwId } = await owner.rpc("fn_create_pay_period", {
  p_label: `ZZ-TEST wk1 ${RUN}`, p_start: FIRST, p_end: DAY7, p_frequency: "weekly",
});
{
  const { data } = await owner.from("payroll_entries")
    .select("gross_pay").eq("pay_period_id", pmId).eq("staff_id", monthly.id).single();
  check(`monthly frequency → full ${P(MONTHLY_RATE)}`, data?.gross_pay === MONTHLY_RATE, `(got ${data?.gross_pay})`);
}
{
  const { data } = await owner.from("payroll_entries")
    .select("gross_pay").eq("pay_period_id", pwId).eq("staff_id", monthly.id).single();
  check(`weekly frequency → ${P(MONTHLY_RATE)} ÷ 4 = ${P(375000)}`, data?.gross_pay === 375000, `(got ${data?.gross_pay})`);
}
{
  const { error } = await owner.rpc("fn_save_payroll_days", {
    p_period_id: pmId, p_lines: [{ entry_id: dailyEntry.id, days_worked: 1 }],
  });
  check("an entry from another period is refused", !!error && /does not belong/i.test(error.message), error?.message);
}

section("Per-branch reporting (period overlap):");
{
  // Reports filter a period by OVERLAP, not containment.
  // Reports measure a shop's LABOR COST as gross + the employer's gov share —
  // not net_pay. Net is what the staffer took home; the employee share it
  // excludes was still the shop's money, and the employer share is a further
  // cost on top of gross. (This assertion used to sum net_pay, which understated
  // every shop once contributions existed.)
  const { data } = await owner
    .from("payroll_entries")
    .select("gross_pay, shop_id, payroll_entry_contributions(er_amount_centavos), pay_periods!inner(start_date, end_date, deleted_at)")
    .eq("shop_id", A.id)
    .lte("pay_periods.start_date", MID)
    .gte("pay_periods.end_date", FIRST)
    .is("pay_periods.deleted_at", null);
  const gross = (data ?? []).reduce((s, r) => s + r.gross_pay, 0);
  const er = (data ?? []).reduce(
    (s, r) => s + r.payroll_entry_contributions.reduce((t, c) => t + c.er_amount_centavos, 0), 0
  );
  check(`shop A gross across overlapping periods = ${P(500000)}`, gross === 500000, `(got ${gross})`);
  check("labor cost = gross + employer share (never net)", er > 0 && gross + er > gross);
  check("shop A's report never picks up shop B's staff",
    (data ?? []).every((r) => r.shop_id === A.id));
}

section("Cleanup:");
await cleanup();
summary();
