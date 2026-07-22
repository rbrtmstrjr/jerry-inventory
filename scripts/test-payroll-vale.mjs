/**
 * 0071 — vale / cash-advance deduction on payroll (tracked ledger).
 *
 * A staffer borrows cash (a "vale") → running balance → deduct installments
 * from their pay until settled, capped to available net with the remainder
 * carrying. Proves: record → balance; deduct → net = gross − vale; cap to the
 * outstanding balance; cap to available net + carry (never a negative paycheck);
 * void (and the refusal once deducted against); no advance → no deduction; a
 * paid payslip is immutable; owner-only authority.
 *
 * Uses a contributions-OFF staffer so net = gross − vale (clean math); the vale
 * interaction with gov shares is the same cap applied to gross − Σ ee.
 */
import {
  owner, RUN, P, check, section, summary,
  provisionShop, cleanup,
} from "./_harness.mjs";

const A = await provisionShop("Vale");
const emp = A.client;

const phToday = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
const [Y, M] = phToday.split("-");
const FIRST = `${Y}-${M}-01`;
const MID = `${Y}-${M}-15`;

const { data: pos } = await owner.from("positions")
  .insert({ title: `ZZ-TEST ValePos ${RUN}`, shop_id: null, default_pay_rate: 50000 })
  .select().single();
const { data: staff } = await owner.from("staff").insert({
  full_name: `ZZ-TEST ValeMark ${RUN}`, shop_id: A.id, position_id: pos.id,
  pay_type: "daily", pay_rate: 50000, contributions_enabled: false,
}).select().single();
const { data: staff2 } = await owner.from("staff").insert({
  full_name: `ZZ-TEST ValeNoAdv ${RUN}`, shop_id: A.id, position_id: pos.id,
  pay_type: "daily", pay_rate: 50000, contributions_enabled: false,
}).select().single();

const balanceOf = async (sid) =>
  (await owner.from("staff_advance_balances").select("balance").eq("staff_id", sid).maybeSingle()).data?.balance ?? 0;
const entryOf = async (periodId, sid) =>
  (await owner.from("payroll_entries")
    .select("id, gross_pay, net_pay, vale_centavos, status")
    .eq("pay_period_id", periodId).eq("staff_id", sid).single()).data;

// ── authority ────────────────────────────────────────────────────────────
section("Authority");
{
  const { error } = await emp.rpc("fn_record_staff_advance", { p_staff_id: staff.id, p_amount_centavos: 100000 });
  check("an employee cannot record an advance", /owner/i.test(error?.message ?? ""));
}

// ── record ───────────────────────────────────────────────────────────────
section("Record a vale");
{
  const { error } = await owner.rpc("fn_record_staff_advance", {
    p_staff_id: staff.id, p_amount_centavos: 200000, p_note: `ZZ-TEST vale ${RUN}`,
  });
  check("owner records a ₱2,000 vale", !error, error?.message);
  check("balance = ₱2,000", (await balanceOf(staff.id)) === 200000);
}

// ── deduct an installment ──────────────────────────────────────────────────
section("Deduct on the payslip");
const { data: periodId } = await owner.rpc("fn_create_pay_period", {
  p_label: `ZZ-TEST vale 1-15 ${RUN}`, p_start: FIRST, p_end: MID, p_frequency: "semi_monthly",
});
let e = await entryOf(periodId, staff.id);
await owner.rpc("fn_save_payroll_days", { p_period_id: periodId, p_lines: [{ entry_id: e.id, days_worked: 10 }] });
e = await entryOf(periodId, staff.id);
check(`gross ${P(500000)}, net ${P(500000)} before any vale`, e.gross_pay === 500000 && e.net_pay === 500000);
{
  const { data: applied, error } = await owner.rpc("fn_save_payroll_vale", { p_entry_id: e.id, p_requested_centavos: 100000 });
  check("deduct a ₱1,000 installment", !error && applied === 100000, error?.message ?? `applied ${applied}`);
  e = await entryOf(periodId, staff.id);
  check(`net = gross − vale (${P(400000)})`, e.net_pay === 400000 && e.vale_centavos === 100000, `net ${e.net_pay}`);
  check("balance drops to ₱1,000", (await balanceOf(staff.id)) === 100000);
}

// ── cap to the outstanding balance ─────────────────────────────────────────
section("Cap to the balance");
{
  const { data: applied } = await owner.rpc("fn_save_payroll_vale", { p_entry_id: e.id, p_requested_centavos: 500000 });
  check("over-request capped to the ₱2,000 ever advanced", applied === 200000, `applied ${applied}`);
  e = await entryOf(periodId, staff.id);
  check(`net = gross − 2,000 = ${P(300000)}`, e.net_pay === 300000 && e.vale_centavos === 200000);
  check("balance settled to ₱0", (await balanceOf(staff.id)) === 0);
}

// ── cap to available net + carry the remainder ─────────────────────────────
section("Cap to net + carry");
{
  await owner.rpc("fn_record_staff_advance", { p_staff_id: staff.id, p_amount_centavos: 1000000 }); // ₱10,000
  check("balance now ₱10,000", (await balanceOf(staff.id)) === 1000000);
  const { data: applied } = await owner.rpc("fn_save_payroll_vale", { p_entry_id: e.id, p_requested_centavos: 1000000 });
  check("capped to available net (gross ₱5,000)", applied === 500000, `applied ${applied}`);
  e = await entryOf(periodId, staff.id);
  check("net floored at ₱0 — never negative", e.net_pay === 0 && e.vale_centavos === 500000);
  check("remainder carries: ₱7,000 balance left", (await balanceOf(staff.id)) === 700000);
}

// ── void ───────────────────────────────────────────────────────────────────
section("Void");
{
  const { data: adv1 } = await owner.from("staff_advances")
    .select("id").eq("staff_id", staff.id).eq("amount_centavos", 200000).is("deleted_at", null).single();
  const { error } = await owner.rpc("fn_void_staff_advance", { p_id: adv1.id });
  check("void a still-covered advance", !error, error?.message);
  check("balance drops by ₱2,000 → ₱5,000", (await balanceOf(staff.id)) === 500000);

  const { data: adv2 } = await owner.from("staff_advances")
    .select("id").eq("staff_id", staff.id).eq("amount_centavos", 1000000).is("deleted_at", null).single();
  const { error: e2 } = await owner.rpc("fn_void_staff_advance", { p_id: adv2.id });
  check("cannot void an advance already deducted against", /already been deducted/i.test(e2?.message ?? ""), e2?.message);
}

// ── no advance = no deduction ──────────────────────────────────────────────
section("No advance = no deduction");
{
  const e2 = await entryOf(periodId, staff2.id);
  await owner.rpc("fn_save_payroll_days", { p_period_id: periodId, p_lines: [{ entry_id: e2.id, days_worked: 5 }] });
  const { data: applied } = await owner.rpc("fn_save_payroll_vale", { p_entry_id: e2.id, p_requested_centavos: 100000 });
  check("a staffer with no advance can't be deducted (₱0 applied)", applied === 0, `applied ${applied}`);
  check("their net is untouched", (await entryOf(periodId, staff2.id)).vale_centavos === 0);
}

// ── a paid payslip is immutable ────────────────────────────────────────────
section("Paid payslip is locked");
{
  await owner.rpc("fn_approve_pay_period", { p_period_id: periodId });
  await owner.rpc("fn_mark_payroll_paid", { p_period_id: periodId, p_entry_ids: [e.id], p_all: false });
  const { error } = await owner.rpc("fn_save_payroll_vale", { p_entry_id: e.id, p_requested_centavos: 10000 });
  check("cannot change the vale on a paid payslip", /paid/i.test(error?.message ?? ""), error?.message);
}

section("Cleanup");
await cleanup();
summary();
