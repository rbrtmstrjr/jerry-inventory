/**
 * PAYROLL SEED — staff, positions, pay periods, entries, advances (vale).
 *
 * The load seed skips payroll on purpose (P&L labor = 0), so every payroll page
 * is empty. This fills it with a realistic spread for QA: 6 positions, ~18 staff
 * across the 5 shops (monthly + daily, enrolled + casual/no-contributions), 6
 * semi-monthly pay periods in different lifecycle states (paid+finalized, paid,
 * approved-unpaid, open draft), plus cash advances (vale) with some deducted and
 * some still outstanding.
 *
 * Driven through the SAME owner-only RPCs the UI calls (fn_create_pay_period,
 * fn_save_payroll_days, fn_approve_pay_period, fn_mark_payroll_paid,
 * fn_set_pay_period_status, fn_record_staff_advance, fn_save_payroll_vale) via a
 * real owner session — so gov contributions (SSS/PhilHealth/Pag-IBIG) resolve
 * from contribution_brackets and freeze into payroll_entry_contributions exactly
 * as in production. Positions/staff are plain owner inserts.
 *
 *   Run anytime after seed-load-test (needs the 5 shops):  node scripts/seed-payroll.mjs
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const url = env.NEXT_PUBLIC_SUPABASE_URL, anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const admin = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const FORCE = process.argv.includes("--force");
const rnd = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const peso = (n) => n * 100;

// owner session (RPCs are is_owner()-guarded)
const { data: us } = await admin.auth.admin.listUsers();
const owner = us.users.find((u) => u.email?.includes("robertmaestro"));
const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: owner.email });
const c = createClient(url, anon, { auth: { persistSession: false } });
await c.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: "email" });
const { data: io } = await c.rpc("is_owner");
if (!io) { console.error("owner session failed"); process.exit(1); }

// guard: payroll should be empty
{
  const { count } = await admin.from("staff").select("id", { count: "exact", head: true }).is("deleted_at", null);
  if (count > 0 && !FORCE) { console.error(`${count} staff already exist — pass --force to add more.`); process.exit(2); }
}

const { data: shops } = await admin.from("shops").select("id, name").is("deleted_at", null).order("name");
console.log(`Seeding payroll across ${shops.length} shops…`);

async function rpc(fn, args) {
  const { data, error } = await c.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

// ── positions (global) ───────────────────────────────────────────────────────
const POS_DEFS = [
  { title: "Store Manager", pay_type: "monthly", rate: peso(18000) },
  { title: "Bookkeeper", pay_type: "monthly", rate: peso(15000) },
  { title: "Cashier", pay_type: "daily", rate: peso(550) },
  { title: "Mechanic", pay_type: "daily", rate: peso(650) },
  { title: "Sales Staff", pay_type: "daily", rate: peso(520) },
  { title: "Helper / Utility", pay_type: "daily", rate: peso(450) },
];
const positions = {};
for (const p of POS_DEFS) {
  const { data, error } = await c.from("positions")
    .insert({ title: p.title, shop_id: null, default_pay_rate: p.rate, active: true })
    .select("id").single();
  if (error) throw new Error(`position ${p.title}: ${error.message}`);
  positions[p.title] = { id: data.id, ...p };
}
console.log(`  ${POS_DEFS.length} positions`);

// ── staff: each shop gets a manager + a couple daily + a casual helper ───────
const FIRST = ["Ramon", "Divina", "Efren", "Marites", "Boyet", "Nena", "Cesar", "Aling", "Danilo", "Luzviminda", "Rico", "Perla", "Manny", "Corazon", "Jomar", "Editha", "Rodel", "Baby"];
const LAST = ["Dela Cruz", "Santos", "Reyes", "Bautista", "Aquino", "Mendoza", "Villanueva", "Ramos", "Navarro", "Salazar", "Gutierrez", "Pascual"];
const govNo = () => `${rnd(10, 99)}-${rnd(1000000, 9999999)}-${rnd(0, 9)}`;
let fi = 0;
const nextName = () => `${FIRST[fi++ % FIRST.length]} ${pick(LAST)}`;

// per-shop templates (title, enrolled). Casual helper => contributions off.
const TEMPLATES = [
  { title: "Store Manager", enrolled: true },
  { title: "Cashier", enrolled: true },
  { title: "Mechanic", enrolled: true },
  { title: "Helper / Utility", enrolled: false },
];
const staff = [];
for (const shop of shops) {
  // vary: some shops get an extra sales/bookkeeper
  const tpls = [...TEMPLATES];
  if (Math.random() < 0.5) tpls.push({ title: "Sales Staff", enrolled: true });
  for (const t of tpls) {
    const pos = positions[t.title];
    const rate = Math.round(pos.rate * (0.9 + Math.random() * 0.25)); // ±spread
    const row = {
      full_name: nextName(), shop_id: shop.id, position_id: pos.id,
      pay_type: pos.pay_type, pay_rate: rate,
      date_hired: `202${rnd(3, 5)}-${String(rnd(1, 12)).padStart(2, "0")}-${String(rnd(1, 28)).padStart(2, "0")}`,
      active: true, contributions_enabled: t.enrolled,
      sss_no: t.enrolled ? govNo() : null,
      philhealth_no: t.enrolled ? govNo() : null,
      pagibig_no: t.enrolled ? govNo() : null,
      notes: t.enrolled ? null : "Casual helper — not enrolled",
    };
    const { data, error } = await c.from("staff").insert(row).select("id").single();
    if (error) throw new Error(`staff ${row.full_name}: ${error.message}`);
    staff.push({ id: data.id, shop: shop.name, ...row });
  }
}
console.log(`  ${staff.length} staff (${staff.filter((s) => s.contributions_enabled).length} enrolled, ${staff.filter((s) => !s.contributions_enabled).length} casual)`);

// ── advances (vale): give ~8 staff a cash advance in May/Jun ─────────────────
const withAdvance = staff.filter(() => Math.random() < 0.45).slice(0, 8);
for (const s of withAdvance) {
  s.advance = peso(rnd(20, 50) * 100); // ₱2,000–5,000
  await rpc("fn_record_staff_advance", {
    p_staff_id: s.id, p_amount_centavos: s.advance,
    p_note: "Cash advance (vale)", p_date: `2026-0${rnd(5, 6)}-${String(rnd(1, 20)).padStart(2, "0")}`,
  });
}
console.log(`  ${withAdvance.length} staff given a cash advance`);

// ── pay periods (semi-monthly) with mixed lifecycle states ───────────────────
const PERIODS = [
  { label: "May 1–15, 2026", start: "2026-05-01", end: "2026-05-15", final: "paid_finalized" },
  { label: "May 16–31, 2026", start: "2026-05-16", end: "2026-05-31", final: "paid_finalized" },
  { label: "Jun 1–15, 2026", start: "2026-06-01", end: "2026-06-15", final: "paid" },
  { label: "Jun 16–30, 2026", start: "2026-06-16", end: "2026-06-30", final: "paid", vale: true },
  { label: "Jul 1–15, 2026", start: "2026-07-01", end: "2026-07-15", final: "approved", vale: true },
  { label: "Jul 16–31, 2026", start: "2026-07-16", end: "2026-07-31", final: "open", vale: true },
];
const staffById = new Map(staff.map((s) => [s.id, s]));
let periodsMade = 0, valeApplied = 0;

for (const P of PERIODS) {
  const pid = await rpc("fn_create_pay_period", { p_label: P.label, p_start: P.start, p_end: P.end, p_frequency: "semi_monthly" });
  // entries were auto-created for every active staffer
  const { data: entries } = await c.from("payroll_entries").select("id, staff_id").eq("pay_period_id", pid);
  // days worked: daily staff 11–13, monthly nominal 15
  const lines = entries.map((e) => {
    const s = staffById.get(e.staff_id);
    return { entry_id: e.id, days_worked: s?.pay_type === "monthly" ? 15 : rnd(11, 13) };
  });
  await rpc("fn_save_payroll_days", { p_period_id: pid, p_lines: lines });

  // deduct a vale installment for advance-holders (before approve/pay)
  if (P.vale) {
    for (const e of entries) {
      const s = staffById.get(e.staff_id);
      if (!s?.advance) continue;
      const applied = await rpc("fn_save_payroll_vale", { p_entry_id: e.id, p_requested_centavos: peso(rnd(8, 15) * 100) });
      if (applied > 0) valeApplied++;
    }
  }

  if (P.final !== "open") await rpc("fn_approve_pay_period", { p_period_id: pid });
  if (P.final === "paid" || P.final === "paid_finalized")
    await rpc("fn_mark_payroll_paid", { p_period_id: pid, p_entry_ids: [], p_all: true });
  if (P.final === "paid_finalized")
    await rpc("fn_set_pay_period_status", { p_period_id: pid, p_finalize: true });

  periodsMade++;
  console.log(`  period ${P.label.padEnd(18)} → ${P.final}  (${entries.length} entries)`);
}

// ── summary ──────────────────────────────────────────────────────────────────
// staff_advance_balances is owner-only (service role reads empty) and its column
// is `balance`, not `balance_centavos` — read it through the owner session.
const { data: bal } = await c.from("staff_advance_balances").select("balance");
const outstanding = (bal ?? []).reduce((t, r) => t + Math.max(0, r.balance), 0);
console.log(`\nDONE — ${POS_DEFS.length} positions · ${staff.length} staff · ${periodsMade} pay periods · ${withAdvance.length} advances (${valeApplied} vale deductions)`);
console.log(`  outstanding vale balance: ₱${(outstanding / 100).toLocaleString()}`);
console.log(`  Payroll → Run Payroll / Staff / Positions / Advances / Reports all populated.`);
