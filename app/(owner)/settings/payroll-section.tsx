"use client";

import type { ContributionBracketRow } from "@/lib/db-types";
import { ContributionRates } from "./contribution-rates";
import { ContributionSettingsForm } from "./contribution-settings-form";
import type { SettingsRow } from "./types";

/**
 * Payroll config: the two dials that turn a rate into a monthly contribution
 * basis, and the effective-dated rate book itself.
 *
 * Both components already existed and are unchanged — this only re-homes them
 * under a tab. The rate book is the single most consequential thing on this
 * page (RATES ARE DATA: a new circular is an edit here, never a redeploy), so
 * it stays exactly as it was rather than being rewritten for a layout change.
 */
export function PayrollSection({
  settings,
  brackets,
}: {
  settings: SettingsRow;
  brackets: ContributionBracketRow[];
}) {
  return (
    <div className="flex flex-col gap-4">
      <ContributionSettingsForm
        workingDays={settings.payroll_working_days_per_month}
        split={settings.contribution_split_semimonthly}
      />
      <ContributionRates brackets={brackets} />
    </div>
  );
}
