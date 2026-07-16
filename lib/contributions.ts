/**
 * Display helpers for government contributions.
 *
 * RATES ARE DATA. Every percentage, bracket, MSC, floor and ceiling lives in
 * `contribution_brackets` and is frozen per entry in
 * `payroll_entry_contributions`. Nothing rate-like may ever appear in this
 * file — it holds agency NAMES and ordering only. If a figure needs showing,
 * read it off the snapshot row.
 */
import type { ContributionAgency, EntryContribution } from "@/lib/db-types";

/** Display order — the order the agencies are listed on a Philippine payslip. */
export const AGENCY_ORDER: readonly ContributionAgency[] = [
  "sss",
  "philhealth",
  "pagibig",
];

export const AGENCY_LABEL: Record<ContributionAgency, string> = {
  sss: "SSS",
  philhealth: "PhilHealth",
  pagibig: "Pag-IBIG",
};

/** Total deducted from the worker's gross. */
export function employeeShare(rows: EntryContribution[]): number {
  return rows.reduce((s, c) => s + c.ee_amount_centavos, 0);
}

/** Total the employer pays on top — never a deduction from the worker. */
export function employerShare(rows: EntryContribution[]): number {
  return rows.reduce((s, c) => s + c.er_amount_centavos, 0);
}

/** Index a snapshot by agency so a row can be looked up in display order. */
export function byAgency(
  rows: EntryContribution[]
): Partial<Record<ContributionAgency, EntryContribution>> {
  return Object.fromEntries(rows.map((c) => [c.agency, c]));
}
