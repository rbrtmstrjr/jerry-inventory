/**
 * Government contributions (SSS / PhilHealth / Pag-IBIG) verification.
 *
 * This computes real people's pay and real remittances, so the numbers here are
 * checked against the published tables, not against the code's own opinion:
 *
 *   SSS        Circular 2024-006 (RA 11199), eff. 2025-01-01, unchanged 2026.
 *              5% EE / 10% ER of the MSC. MSC P5,000..P35,000 in P500 steps.
 *              Range of Compensation for MSC m is [m-250, m+250).
 *              EC (employer-only): P10 below MSC 15,000, P30 from 15,000 up.
 *   PhilHealth RA 11223. 5% -> 2.5% / 2.5%, floor P10,000, ceiling P100,000.
 *   Pag-IBIG   HDMF Circular 460. MFS P10,000. <=P1,500: 1%/2%. >P1,500: 2%/2%.
 *
 * Covers: rates-are-data (nothing hardcoded), bracket resolution incl. the
 * MSC lookup, floor/ceiling clamps, daily-rate basis, semi-monthly splits,
 * net = gross - EE, employer share never reduces net, enrollment toggle,
 * historical integrity, remittance totals, and owner-only access.
 *
 * Run: node scripts/test-payroll-contributions.mjs
 */
import {
  owner, admin, RUN, P, check, section, summary,
  provisionShop, cleanup,
} from "./_harness.mjs";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const shop = await provisionShop("Payroll");
const emp = shop.client;
const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });

// This suite has to flip live settings to prove they drive the computation.
// Capture the owner's real values and put them back no matter how we exit — an
// interrupted run must not leave the business on the wrong working-day count.
const { data: originalSettings } = await owner
  .from("settings")
  .select("payroll_working_days_per_month, contribution_split_semimonthly")
  .eq("id", 1).single();

let settingsRestored = false;
async function restoreSettings() {
  if (settingsRestored) return;
  settingsRestored = true;
  await admin.from("settings").update(originalSettings).eq("id", 1);
}
for (const sig of ["exit", "SIGINT", "SIGTERM", "uncaughtException"]) {
  process.on(sig, () => { void restoreSettings(); });
}

// ── 0. Rates are DATA, not code ──────────────────────────────────────────────
// The whole design rests on this: a new circular must be a data edit. If a rate
// leaks into app code, the next circular silently needs a developer.
section("Rates live in the database, not in application code:");
{
  const roots = ["app", "lib", "components"];
  const hits = [];
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx)$/.test(p)) continue;
      const src = readFileSync(p, "utf8");
      // The literal rates/boundaries from the three agencies' tables.
      const patterns = [
        /\b2\.5\s*%/, /\bee_percent\s*[:=]\s*\d/, /\ber_percent\s*[:=]\s*\d/,
        /\b35000000\b/, /\b10000000\b/, /\b1000000\b/,   // 350k? / 100k / 10k ceilings
        /\bMSC\s*[:=]\s*\d/, /\b3500000\b/, /\b500000\b/, // MSC ceiling / floor
      ];
      for (const re of patterns) {
        const m = src.match(re);
        if (m) hits.push(`${p}: ${m[0]}`);
      }
    }
  };
  roots.forEach(walk);
  check(
    "no rate / MSC / floor / ceiling literal in app code",
    hits.length === 0,
    hits.slice(0, 6).join(" | ")
  );
}
{
  const { data } = await owner
    .from("contribution_brackets").select("agency").is("deleted_at", null);
  const by = (a) => data.filter((r) => r.agency === a).length;
  check(`SSS seeded with 61 MSC brackets`, by("sss") === 61, String(by("sss")));
  check(`PhilHealth seeded with 1 row`, by("philhealth") === 1, String(by("philhealth")));
  check(`Pag-IBIG seeded with 2 rows`, by("pagibig") === 2, String(by("pagibig")));
}
{
  const { data } = await owner
    .from("contribution_brackets").select("source_ref").is("deleted_at", null);
  check(
    "every bracket cites the circular it came from",
    data.every((r) => !!r.source_ref)
  );
}

// ── 1. SSS: bracket -> MSC lookup, NOT a percent of pay ──────────────────────
section("SSS — the MSC lookup (published table):");
const resolve = async (agency, basis, onDate = today) => {
  const { data, error } = await owner.rpc("fn_resolve_contribution", {
    p_agency: agency, p_basis_centavos: basis, p_on_date: onDate,
  });
  if (error) throw new Error(`${agency} @ ${basis}: ${error.message}`);
  return data[0];
};
{
  // Range of Compensation 18,250-18,749.99 -> MSC 18,500
  const r = await resolve("sss", 1830000);
  check("P18,300 basis resolves to MSC P18,500", r.credited_salary_centavos === 1850000, P(r.credited_salary_centavos));
  check(`EE = ${P(92500)} (5% of the MSC)`, r.ee_amount_centavos === 92500, P(r.ee_amount_centavos));
  check(`ER = ${P(188000)} (10% of MSC + P30 EC)`, r.er_amount_centavos === 188000, P(r.er_amount_centavos));
}
{
  // The point of a bracket: pay moves, the deduction doesn't.
  const a = await resolve("sss", 1830000);
  const b = await resolve("sss", 1850000);
  const c = await resolve("sss", 1870000);
  check(
    "a P200 raise inside the same bracket does NOT change the deduction",
    a.ee_amount_centavos === b.ee_amount_centavos &&
    b.ee_amount_centavos === c.ee_amount_centavos
  );
}
{
  const r = await resolve("sss", 300000); // P3,000 — below the table
  check("below the floor -> MSC P5,000", r.credited_salary_centavos === 500000, P(r.credited_salary_centavos));
  check(`floor EE = ${P(25000)}`, r.ee_amount_centavos === 25000, P(r.ee_amount_centavos));
  check("floor EC = P10 (MSC under 15,000)", r.er_amount_centavos === 51000, P(r.er_amount_centavos));
}
{
  const r = await resolve("sss", 9900000); // P99,000 — above the table
  check("above the ceiling -> MSC P35,000", r.credited_salary_centavos === 3500000, P(r.credited_salary_centavos));
  check(`ceiling EE = ${P(175000)}`, r.ee_amount_centavos === 175000, P(r.ee_amount_centavos));
  check("ceiling EC = P30 (MSC 15,000+)", r.er_amount_centavos === 353000, P(r.er_amount_centavos));
}
{
  // Published totals: P760 at the MSC floor, P5,280 at the ceiling.
  const lo = await resolve("sss", 100000);
  const hi = await resolve("sss", 9900000);
  check(
    `total at the floor = ${P(76000)} (published)`,
    lo.ee_amount_centavos + lo.er_amount_centavos === 76000
  );
  check(
    `total at the ceiling = ${P(528000)} (published)`,
    hi.ee_amount_centavos + hi.er_amount_centavos === 528000
  );
}
{
  // EC steps at MSC 15,000 exactly.
  const under = await resolve("sss", 1450000); // MSC 14,500
  const at = await resolve("sss", 1500000);    // MSC 15,000
  const ecUnder = under.er_amount_centavos - Math.round(under.credited_salary_centavos * 0.10);
  const ecAt = at.er_amount_centavos - Math.round(at.credited_salary_centavos * 0.10);
  check("EC is P10 below MSC 15,000", ecUnder === 1000, P(ecUnder));
  check("EC is P30 at MSC 15,000", ecAt === 3000, P(ecAt));
}

// ── 2. PhilHealth: clamp then percent ────────────────────────────────────────
section("PhilHealth — floor/ceiling clamp:");
{
  const r = await resolve("philhealth", 800000);
  check("P8,000 clamps to the P10,000 floor -> P250 / P250",
    r.ee_amount_centavos === 25000 && r.er_amount_centavos === 25000);
}
{
  const r = await resolve("philhealth", 2000000);
  check("P20,000 -> P500 / P500", r.ee_amount_centavos === 50000 && r.er_amount_centavos === 50000);
}
{
  const r = await resolve("philhealth", 15000000);
  check("P150,000 clamps to the P100,000 ceiling -> P2,500 / P2,500",
    r.ee_amount_centavos === 250000 && r.er_amount_centavos === 250000);
}

// ── 3. Pag-IBIG: two tiers + MFS cap ─────────────────────────────────────────
section("Pag-IBIG — tier + Maximum Fund Salary cap:");
{
  const r = await resolve("pagibig", 120000);
  check("P1,200 -> EE P12 (1%) / ER P24 (2%)",
    r.ee_amount_centavos === 1200 && r.er_amount_centavos === 2400,
    `${P(r.ee_amount_centavos)} / ${P(r.er_amount_centavos)}`);
}
{
  const r = await resolve("pagibig", 650000);
  check("P6,500 -> P130 / P130", r.ee_amount_centavos === 13000 && r.er_amount_centavos === 13000);
}
{
  const r = await resolve("pagibig", 2500000);
  check("P25,000 caps at the P10,000 MFS -> P200 / P200",
    r.ee_amount_centavos === 20000 && r.er_amount_centavos === 20000);
}

// ── 4. Exactly one bracket per agency+date+basis (DB-enforced) ───────────────
section("Bracket resolution is unambiguous:");
{
  const { data } = await owner
    .from("contribution_brackets").select("id")
    .eq("agency", "sss").is("deleted_at", null)
    .lte("salary_min_centavos", 1830000)
    .or("salary_max_centavos.is.null,salary_max_centavos.gte.1830000");
  check("exactly ONE SSS row covers P18,300", data?.length === 1, `${data?.length} rows`);
}
{
  // The exclusion constraint must refuse an overlapping row, not the app.
  const { error } = await owner.from("contribution_brackets").insert({
    agency: "philhealth", effective_from: "2025-06-01", effective_to: null,
    salary_min_centavos: 0, salary_max_centavos: null,
    basis: "percent_of_salary", ee_percent: 3, er_percent: 3,
    source_ref: `ZZ-TEST overlap ${RUN}`,
  });
  check(
    "DB REJECTS an overlapping bracket (exclusion constraint)",
    !!error && /overlap|exclusion|conflict/i.test(error.message),
    error?.message ?? "the overlap was accepted!"
  );
}

// ── 5. Basis: monthly vs daily ───────────────────────────────────────────────
section("Monthly basis derivation:");
const { data: pos } = await owner.from("positions").insert({
  title: `ZZ-TEST Mechanic ${RUN}`, shop_id: shop.id, default_pay_rate: 60000,
}).select().single();

const mkStaff = async (label, pay_type, pay_rate, enabled = true) => {
  const { data, error } = await owner.from("staff").insert({
    shop_id: shop.id, full_name: `ZZ-TEST ${label} ${RUN}`,
    position_id: pos.id, pay_type, pay_rate,
    contributions_enabled: enabled,
    sss_no: "34-1234567-8", philhealth_no: "12-345678901-2", pagibig_no: "1234-5678-9012",
  }).select().single();
  if (error) throw new Error(`staff ${label}: ${error.message}`);
  return data;
};

// P18,300/month -> MSC 18,500
const monthlyStaff = await mkStaff("Monthly", "monthly", 1830000);
// P600/day x 26 working days = P15,600/month
const dailyStaff = await mkStaff("Daily", "daily", 60000);
const casualStaff = await mkStaff("Casual", "monthly", 1830000, false);

{
  const { data } = await owner.rpc("fn_contribution_basis", {
    p_pay_type: "monthly", p_rate: 1830000,
  });
  check("monthly staff: basis = their salary", Number(data) === 1830000, String(data));
}
// Pin the working-day count for the rest of the run so the expected numbers
// below are stable regardless of what the owner has it set to.
await owner.from("settings").update({ payroll_working_days_per_month: 26 }).eq("id", 1);
{
  const { data } = await owner.rpc("fn_contribution_basis", {
    p_pay_type: "daily", p_rate: 60000,
  });
  check("daily staff: basis = rate x 26 working days = P15,600", Number(data) === 1560000, String(data));
}
{
  // The setting must actually drive it — otherwise it's decoration.
  await owner.from("settings").update({ payroll_working_days_per_month: 22 }).eq("id", 1);
  const { data } = await owner.rpc("fn_contribution_basis", {
    p_pay_type: "daily", p_rate: 60000,
  });
  check("changing working-days to 22 changes the basis to P13,200", Number(data) === 1320000, String(data));
  await owner.from("settings").update({ payroll_working_days_per_month: 26 }).eq("id", 1);
}

// ── 6. A monthly period end to end ───────────────────────────────────────────
section("Monthly period — Gross -> EE -> Net:");
const { data: periodId, error: pErr } = await owner.rpc("fn_create_pay_period", {
  p_label: `ZZ-TEST Monthly ${RUN}`,
  p_start: `${today.slice(0, 8)}01`, p_end: today,
  p_frequency: "monthly",
});
check("monthly period created", !pErr, pErr?.message);

const entryFor = async (staffId) => {
  const { data } = await owner
    .from("payroll_entries")
    .select("id, gross_pay, net_pay, payroll_entry_contributions(agency, ee_amount_centavos, er_amount_centavos, credited_salary_centavos, salary_basis_centavos, bracket_id)")
    .eq("pay_period_id", periodId).eq("staff_id", staffId).single();
  return data;
};
{
  const e = await entryFor(monthlyStaff.id);
  const ee = e.payroll_entry_contributions.reduce((s, c) => s + c.ee_amount_centavos, 0);
  const er = e.payroll_entry_contributions.reduce((s, c) => s + c.er_amount_centavos, 0);
  const sss = e.payroll_entry_contributions.find((c) => c.agency === "sss");
  const ph = e.payroll_entry_contributions.find((c) => c.agency === "philhealth");
  const pi = e.payroll_entry_contributions.find((c) => c.agency === "pagibig");

  check("all three agencies snapshotted", e.payroll_entry_contributions.length === 3);
  check(`SSS EE ${P(92500)} (MSC ${P(1850000)})`, sss.ee_amount_centavos === 92500 && sss.credited_salary_centavos === 1850000);
  check(`PhilHealth EE ${P(45750)} (2.5% of P18,300)`, ph.ee_amount_centavos === 45750, P(ph.ee_amount_centavos));
  check(`Pag-IBIG EE ${P(20000)} (capped at MFS)`, pi.ee_amount_centavos === 20000, P(pi.ee_amount_centavos));
  check(`total EE = ${P(158250)}`, ee === 158250, P(ee));
  check(
    `net = gross ${P(e.gross_pay)} - EE ${P(ee)} = ${P(e.gross_pay - ee)}`,
    e.net_pay === e.gross_pay - ee, P(e.net_pay)
  );
  check("employer share does NOT reduce net", e.net_pay === e.gross_pay - ee && er > 0);
  check("every snapshot records the bracket it used (audit trail)",
    e.payroll_entry_contributions.every((c) => !!c.bracket_id));
}
{
  const e = await entryFor(casualStaff.id);
  check("not enrolled -> zero contributions", e.payroll_entry_contributions.length === 0);
  check("not enrolled -> net = gross", e.net_pay === e.gross_pay);
}
{
  // A daily staffer drafts at 0 days -> gross 0. You cannot withhold from pay
  // that isn't there (and net_pay has CHECK >= 0), so a 0-gross entry carries
  // no contributions at all rather than going negative.
  const e = await entryFor(dailyStaff.id);
  check("0-day draft: gross is 0", e.gross_pay === 0);
  check("0 gross -> nothing withheld (net_pay >= 0 holds)", e.payroll_entry_contributions.length === 0);
  check("0 gross -> net 0", e.net_pay === 0);
}
{
  // Once days are entered, the deduction appears — computed from the RATE, so
  // it does not scale with the days worked.
  const e = await entryFor(dailyStaff.id);
  const { error } = await owner.rpc("fn_save_payroll_days", {
    p_period_id: periodId, p_lines: [{ entry_id: e.id, days_worked: 20 }],
  });
  check("days saved", !error, error?.message);

  const after = await entryFor(dailyStaff.id);
  const afterEe = after.payroll_entry_contributions.reduce((s, c) => s + c.ee_amount_centavos, 0);
  const sss = after.payroll_entry_contributions.find((c) => c.agency === "sss");
  check("gross followed the days worked", after.gross_pay === 60000 * 20, P(after.gross_pay));
  check(
    "basis is still rate x working-days (P15,600), NOT the 20 days actually worked",
    sss.salary_basis_centavos === 1560000, P(sss.salary_basis_centavos)
  );
  check("net = gross - EE", after.net_pay === after.gross_pay - afterEe);

  // 24 days vs 20 days: gross moves, the deduction does not.
  await owner.rpc("fn_save_payroll_days", {
    p_period_id: periodId, p_lines: [{ entry_id: e.id, days_worked: 24 }],
  });
  const more = await entryFor(dailyStaff.id);
  const moreEe = more.payroll_entry_contributions.reduce((s, c) => s + c.ee_amount_centavos, 0);
  check("more days -> more gross", more.gross_pay > after.gross_pay);
  check("...but the contribution did NOT swing with attendance", moreEe === afterEe, P(moreEe));
  await owner.rpc("fn_save_payroll_days", {
    p_period_id: periodId, p_lines: [{ entry_id: e.id, days_worked: 20 }],
  });
}

// ── Editable contributions (0078): the probationary override ─────────────────
section("Editable government contributions (probation override, 0078):");
{
  const e = await entryFor(dailyStaff.id);
  const eeBefore = e.payroll_entry_contributions.reduce((s, c) => s + c.ee_amount_centavos, 0);
  check("enrolled staffer starts with a computed employee share", eeBefore > 0, P(eeBefore));

  // Override all three to zero — a staffer still on probation.
  const { error: zErr } = await owner.rpc("fn_save_entry_contributions", {
    p_entry_id: e.id, p_amounts: { sss: 0, philhealth: 0, pagibig: 0 },
  });
  check("owner zeroed the three fields", !zErr, zErr?.message);

  const zeroed = await entryFor(dailyStaff.id);
  const eeZero = zeroed.payroll_entry_contributions.reduce((s, c) => s + c.ee_amount_centavos, 0);
  check("all three employee shares are now 0", eeZero === 0);
  check("employer share is untouched (still computed)",
    zeroed.payroll_entry_contributions.some((c) => c.er_amount_centavos > 0));
  check("net recomputed to gross (nothing withheld)", zeroed.net_pay === zeroed.gross_pay, P(zeroed.net_pay));

  // The override SURVIVES a later recompute — the whole reason it persists.
  await owner.rpc("fn_save_payroll_days", {
    p_period_id: periodId, p_lines: [{ entry_id: e.id, days_worked: 20 }],
  });
  const after = await entryFor(dailyStaff.id);
  const eeAfter = after.payroll_entry_contributions.reduce((s, c) => s + c.ee_amount_centavos, 0);
  check("override persists through Save days (not recomputed from the book)", eeAfter === 0);

  // A partial override: set only SSS; the omitted agencies revert to computed.
  await owner.rpc("fn_save_entry_contributions", {
    p_entry_id: e.id, p_amounts: { sss: 12345 },
  });
  const partial = await entryFor(dailyStaff.id);
  const sss = partial.payroll_entry_contributions.find((c) => c.agency === "sss");
  const ph = partial.payroll_entry_contributions.find((c) => c.agency === "philhealth");
  check("SSS took the override amount", sss.ee_amount_centavos === 12345, P(sss.ee_amount_centavos));
  check("an omitted agency reverts to the computed amount", ph.ee_amount_centavos > 0, P(ph.ee_amount_centavos));

  // Guardrails.
  const { error: negErr } = await owner.rpc("fn_save_entry_contributions", {
    p_entry_id: e.id, p_amounts: { sss: -100 },
  });
  check("negative amount refused", !!negErr);

  const casual = await entryFor(casualStaff.id);
  const { error: enrErr } = await owner.rpc("fn_save_entry_contributions", {
    p_entry_id: casual.id, p_amounts: { sss: 0 },
  });
  check("not-enrolled staffer has no contributions to edit",
    !!enrErr && /no contributions/i.test(enrErr.message));

  const { error: authErr } = await emp.rpc("fn_save_entry_contributions", {
    p_entry_id: e.id, p_amounts: { sss: 0 },
  });
  check("employee cannot edit contributions (owner-only)", !!authErr);

  // Clear the override so the remittance-totals section below sees real amounts.
  await owner.rpc("fn_save_entry_contributions", { p_entry_id: e.id, p_amounts: {} });
}

{
  // Earning less in a month than you owe in contributions is not a call payroll
  // software should quietly make (zero someone's pay? under-remit?). It stops
  // and makes the owner decide.
  const e = await entryFor(dailyStaff.id);
  const { error } = await owner.rpc("fn_save_payroll_days", {
    p_period_id: periodId, p_lines: [{ entry_id: e.id, days_worked: 1 }],
  });
  check(
    "gross below the total employee share is REFUSED, not silently absorbed",
    !!error && /gross for this period is only/i.test(error.message),
    error?.message ?? "it silently zeroed their pay!"
  );
  await owner.rpc("fn_save_payroll_days", {
    p_period_id: periodId, p_lines: [{ entry_id: e.id, days_worked: 20 }],
  });
}

// ── 7. Remittance totals ─────────────────────────────────────────────────────
section("Remittance totals (what the owner hands each agency):");
{
  const { data, error } = await owner.rpc("fn_remittance_totals", { p_period_id: periodId });
  check("totals returned per agency", !error && data.length === 3, error?.message);
  const sss = data.find((r) => r.agency === "sss");
  check(
    `SSS total to remit = EE ${P(sss.ee_total_centavos)} + ER ${P(sss.er_total_centavos)} = ${P(sss.total_centavos)}`,
    sss.total_centavos === sss.ee_total_centavos + sss.er_total_centavos
  );
  // Cross-check against the raw snapshots.
  const { data: raw } = await owner
    .from("payroll_entry_contributions")
    .select("agency, ee_amount_centavos, er_amount_centavos, payroll_entries!inner(pay_period_id)")
    .eq("payroll_entries.pay_period_id", periodId).eq("agency", "sss");
  const rawEe = raw.reduce((s, c) => s + c.ee_amount_centavos, 0);
  check("remittance total ties out to the per-entry snapshots", sss.ee_total_centavos === rawEe);
}
{
  // fn_create_pay_period drafts an entry for EVERY active staff member, so this
  // period also holds the real staff. Assert on our own fixtures rather than a
  // global count, which would flap as real staff come and go.
  const { data: mine } = await owner
    .from("payroll_entries")
    .select("staff_id, payroll_entry_contributions(agency), staff!inner(full_name)")
    .eq("pay_period_id", periodId)
    .like("staff.full_name", `%${RUN}%`);
  const enrolled = mine.filter((e) => e.payroll_entry_contributions.length > 0);
  check(
    "of our 3 staff, only the 2 enrolled ones have contributions",
    mine.length === 3 && enrolled.length === 2,
    `${mine.length} entries, ${enrolled.length} enrolled`
  );
}

// ── 8. Semi-monthly splits ───────────────────────────────────────────────────
section("Semi-monthly split (half_each):");
const mkSemi = async (label, start, end) => {
  const { data, error } = await owner.rpc("fn_create_pay_period", {
    p_label: `ZZ-TEST ${label} ${RUN}`, p_start: start, p_end: end,
    p_frequency: "semi_monthly",
  });
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
};
const ym = today.slice(0, 8);
const eeFor = async (pid, staffId, agency) => {
  const { data } = await owner
    .from("payroll_entries")
    .select("payroll_entry_contributions(agency, ee_amount_centavos)")
    .eq("pay_period_id", pid).eq("staff_id", staffId).single();
  return data.payroll_entry_contributions.find((c) => c.agency === agency)?.ee_amount_centavos ?? 0;
};
{
  const p1 = await mkSemi("Semi 1st", `${ym}01`, `${ym}15`);
  const p2 = await mkSemi("Semi 2nd", `${ym}16`, today > `${ym}16` ? today : `${ym}28`);
  const first = await eeFor(p1, monthlyStaff.id, "sss");
  const second = await eeFor(p2, monthlyStaff.id, "sss");
  check(`1st cutoff SSS EE = ${P(46250)} (half of ${P(92500)})`, first === 46250, P(first));
  check(`2nd cutoff SSS EE = ${P(46250)}`, second === 46250, P(second));
  check("the two halves sum EXACTLY to the monthly obligation", first + second === 92500);

  // PhilHealth EE is P457.50 -> an odd number of centavos (45750) splits
  // 22875/22875; the rule must never invent or lose a centavo.
  const ph1 = await eeFor(p1, monthlyStaff.id, "philhealth");
  const ph2 = await eeFor(p2, monthlyStaff.id, "philhealth");
  check(`PhilHealth halves sum exactly to ${P(45750)}`, ph1 + ph2 === 45750, `${P(ph1)} + ${P(ph2)}`);
}
section("Semi-monthly split (second_cutoff):");
{
  await owner.from("settings").update({ contribution_split_semimonthly: "second_cutoff" }).eq("id", 1);
  const p1 = await mkSemi("Cutoff 1st", `${ym}01`, `${ym}15`);
  const p2 = await mkSemi("Cutoff 2nd", `${ym}16`, today > `${ym}16` ? today : `${ym}28`);
  const first = await eeFor(p1, monthlyStaff.id, "sss");
  const second = await eeFor(p2, monthlyStaff.id, "sss");
  check("1st cutoff takes nothing", first === 0, P(first));
  check(`2nd cutoff takes the whole ${P(92500)}`, second === 92500, P(second));
  await owner.from("settings").update({ contribution_split_semimonthly: "half_each" }).eq("id", 1);
}

// ── 9. Historical integrity ──────────────────────────────────────────────────
section("Editing the rate book does NOT rewrite history:");
{
  const before = await entryFor(monthlyStaff.id);
  const beforeEe = before.payroll_entry_contributions
    .find((c) => c.agency === "philhealth").ee_amount_centavos;

  // Retire PhilHealth's current row and publish a hypothetical new rate.
  const { data: ph } = await owner
    .from("contribution_brackets").select("id")
    .eq("agency", "philhealth").is("deleted_at", null).single();
  await owner.from("contribution_brackets")
    .update({ effective_to: "2026-12-31" }).eq("id", ph.id);
  const { error: insErr } = await owner.from("contribution_brackets").insert({
    agency: "philhealth", effective_from: "2027-01-01", effective_to: null,
    salary_min_centavos: 0, salary_max_centavos: null,
    basis: "percent_of_salary", ee_percent: 5, er_percent: 5,
    basis_floor_centavos: 1000000, basis_ceiling_centavos: 10000000,
    source_ref: `ZZ-TEST hypothetical 2027 ${RUN}`,
  });
  check("a future-dated rate can be published alongside the current one", !insErr, insErr?.message);

  const after = await entryFor(monthlyStaff.id);
  const afterEe = after.payroll_entry_contributions
    .find((c) => c.agency === "philhealth").ee_amount_centavos;
  check("the already-computed entry is untouched", afterEe === beforeEe, `${P(beforeEe)} -> ${P(afterEe)}`);

  // ...and the new rate applies from its effective date, not before.
  const nowR = await resolve("philhealth", 1830000, today);
  const futureR = await resolve("philhealth", 1830000, "2027-06-01");
  check("today still resolves to the old rate", nowR.ee_amount_centavos === 45750, P(nowR.ee_amount_centavos));
  check("2027 resolves to the new rate", futureR.ee_amount_centavos === 91500, P(futureR.ee_amount_centavos));

  // put it back
  await owner.from("contribution_brackets").delete().eq("source_ref", `ZZ-TEST hypothetical 2027 ${RUN}`);
  await owner.from("contribution_brackets").update({ effective_to: null }).eq("id", ph.id);
}

// ── Per-run deduction choice (0080): deduct once a month ─────────────────────
section("Per-run deduction choice (0080): semi-monthly withholds once a month:");
{
  // The full monthly employee share (from the monthly period, untouched).
  const monthly = await entryFor(monthlyStaff.id);
  const fullEe = monthly.payroll_entry_contributions.reduce((s, c) => s + c.ee_amount_centavos, 0);
  check("baseline: monthly staffer has a full employee share", fullEe > 0, P(fullEe));

  const semiEntry = async (periodId) =>
    (await owner
      .from("payroll_entries")
      .select("id, gross_pay, net_pay, payroll_entry_contributions(ee_amount_centavos)")
      .eq("pay_period_id", periodId).eq("staff_id", monthlyStaff.id).single()).data;

  // A semi-monthly run that does NOT deduct → zero contributions for everyone.
  const { data: pOff, error: offErr } = await owner.rpc("fn_create_pay_period", {
    p_label: `ZZ-TEST semi off ${RUN}`, p_start: "2026-06-01", p_end: "2026-06-15",
    p_frequency: "semi_monthly", p_deduct_contributions: false,
  });
  check("semi-monthly no-deduct period created", !offErr, offErr?.message);
  const off = await semiEntry(pOff);
  check("no-deduct run withholds nothing", off.payroll_entry_contributions.length === 0);
  check("no-deduct run: net = gross", off.net_pay === off.gross_pay, P(off.net_pay));

  // A semi-monthly run that DOES deduct → the FULL monthly amount (not ÷2).
  const { data: pOn, error: onErr } = await owner.rpc("fn_create_pay_period", {
    p_label: `ZZ-TEST semi on ${RUN}`, p_start: "2026-06-16", p_end: "2026-06-30",
    p_frequency: "semi_monthly", p_deduct_contributions: true,
  });
  check("semi-monthly deducting period created", !onErr, onErr?.message);
  const on = await semiEntry(pOn);
  const onEe = on.payroll_entry_contributions.reduce((s, c) => s + c.ee_amount_centavos, 0);
  check("deducting run withholds the FULL monthly amount (not half)",
    onEe === fullEe, `${P(onEe)} vs full ${P(fullEe)}`);
  check("deducting run: net = gross - full EE", on.net_pay === on.gross_pay - onEe);
}

// ── 10. Owner-only ───────────────────────────────────────────────────────────
section("Owner-only:");
for (const table of ["contribution_brackets", "payroll_entry_contributions", "staff", "payroll_entries"]) {
  const { data } = await emp.from(table).select("*").limit(3);
  check(`employee sees ZERO rows in ${table}`, (data ?? []).length === 0, `got ${data?.length}`);
}
{
  const { error } = await emp.rpc("fn_resolve_contribution", {
    p_agency: "sss", p_basis_centavos: 1830000, p_on_date: today,
  });
  check("employee cannot even resolve a rate", !!error, "employee resolved a rate!");
}
{
  const { error } = await emp.from("contribution_brackets").insert({
    agency: "sss", effective_from: "2030-01-01",
    salary_min_centavos: 0, basis: "percent_of_salary", ee_percent: 0, er_percent: 0,
  });
  check("employee cannot publish a rate", !!error);
}

section("Cleanup:");
await admin.from("contribution_brackets").delete().like("source_ref", `%${RUN}%`);
await cleanup();
{
  const { data } = await owner
    .from("contribution_brackets").select("agency").is("deleted_at", null);
  check(
    `rate book intact: ${data.length} brackets (61 SSS + 1 PhilHealth + 2 Pag-IBIG)`,
    data.length === 64
  );
}
summary();
