"use client";

import * as React from "react";
import { CalendarRange, Loader2, Save } from "lucide-react";
import { toast } from "sonner";

import type { SemimonthlySplit } from "@/lib/db-types";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { updateContributionSettings } from "./actions";

const SPLIT_OPTIONS: { value: SemimonthlySplit; label: string; hint: string }[] = [
  {
    value: "half_each",
    label: "Half on each cutoff",
    hint: "Each cutoff carries half the month's obligation. The first cutoff rounds down and the second takes the remainder, so the two always sum to exactly the monthly figure — the remittance ties out to the agency's number with no stray centavo.",
  },
  {
    value: "second_cutoff",
    label: "All on the second cutoff",
    hint: "The first cutoff deducts nothing; the whole month's obligation comes off the second. Take-home is uneven between cutoffs, which staff notice.",
  },
];

/**
 * The two dials that turn a pay rate into a monthly contribution basis, and
 * that basis into per-cutoff deductions. Both are settings, not constants —
 * the DB holds the values and the CHECK holds the bounds.
 */
export function ContributionSettingsForm({
  workingDays,
  split,
}: {
  workingDays: number;
  split: SemimonthlySplit;
}) {
  // Seeded from the database — never from a literal in this file.
  const [days, setDays] = React.useState(String(workingDays));
  const [splitValue, setSplitValue] = React.useState<SemimonthlySplit>(split);
  const [busy, setBusy] = React.useState(false);

  const activeHint = SPLIT_OPTIONS.find((o) => o.value === splitValue)?.hint;

  async function onSave() {
    const parsed = Number(days);
    if (!Number.isInteger(parsed)) {
      toast.error("Working days must be a whole number");
      return;
    }
    setBusy(true);
    const res = await updateContributionSettings({
      payroll_working_days_per_month: parsed,
      contribution_split_semimonthly: splitValue,
    });
    setBusy(false);
    if (res.ok) toast.success("Contribution settings saved");
    else toast.error(res.error);
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarRange className="size-4" /> Contribution Basis
        </CardTitle>
        <CardDescription>
          How payroll works out what a contribution is computed on, and when it
          is deducted.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="set-working-days">Working days per month</Label>
          <Input
            id="set-working-days"
            inputMode="numeric"
            className="w-32"
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Turns a daily rate into a monthly contribution basis: daily rate ×
            this number. Deliberately independent of days actually worked — a
            contribution is a monthly obligation from the staff member&apos;s
            rate, so it does not swing with attendance. Monthly-rate staff use
            their rate directly and ignore this.
          </p>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="set-split">Semi-monthly split</Label>
          <Select
            value={splitValue}
            onValueChange={(v) => setSplitValue(v as SemimonthlySplit)}
          >
            <SelectTrigger id="set-split" className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SPLIT_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{activeHint}</p>
          <p className="text-xs text-muted-foreground">
            Only affects semi-monthly periods. A monthly period always deducts
            the whole obligation; weekly periods carry no contributions at all,
            because the agencies define no weekly split.
          </p>
        </div>

        <div>
          <Button onClick={onSave} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save contribution settings
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
