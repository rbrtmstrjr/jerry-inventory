import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { Anchor } from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { getBusinessIdentity } from "@/lib/business-identity";
import { formatCentavos } from "@/lib/format";
import type { EntryContribution } from "@/lib/db-types";
import {
  AGENCY_LABEL,
  AGENCY_ORDER,
  byAgency,
  employeeShare,
  employerShare,
} from "@/lib/contributions";
import { Badge } from "@/components/ui/badge";
import { PrintButton } from "@/components/shell/print-button";

export const metadata: Metadata = { title: "Payslip" };

export default async function PayslipPage({
  params,
}: {
  params: Promise<{ entryId: string }>;
}) {
  const { entryId } = await params;
  const supabase = await createClient();

  const [entryRes, business] = await Promise.all([
    supabase
      .from("payroll_entries")
      .select(
        `id, days_worked, gross_pay, net_pay, status, date_paid, note,
         staff(full_name, pay_type, pay_rate, date_hired, contributions_enabled,
               sss_no, philhealth_no, pagibig_no, positions(title)),
         shops(name, location),
         pay_periods(label, start_date, end_date, frequency),
         payroll_entry_contributions(
           agency, salary_basis_centavos, credited_salary_centavos,
           ee_amount_centavos, er_amount_centavos
         )`
      )
      .eq("id", entryId)
      .single(),
    getBusinessIdentity(supabase),
  ]);

  const entry = entryRes.data;
  if (!entry) notFound();

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const e = entry as any;
  const staff = e.staff;
  const period = e.pay_periods;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const slipNo = `PS-${e.id.slice(0, 8).toUpperCase()}`;
  const isDaily = staff?.pay_type === "daily";

  // Frozen snapshot — the amounts this entry was actually computed with.
  const contributions: EntryContribution[] = e.payroll_entry_contributions ?? [];
  const contrib = byAgency(contributions);
  const totalEE = employeeShare(contributions);
  const totalER = employerShare(contributions);
  const enrolled = staff?.contributions_enabled ?? true;

  const govIds: { label: string; value: string | null }[] = [
    { label: "SSS", value: staff?.sss_no ?? null },
    { label: "PhilHealth", value: staff?.philhealth_no ?? null },
    { label: "Pag-IBIG", value: staff?.pagibig_no ?? null },
  ];

  return (
    <div className="mx-auto max-w-lg">
      <div className="mb-4 flex justify-end print:hidden">
        <PrintButton label="Print payslip" />
      </div>

      <div className="rounded-lg border bg-card p-8 print:rounded-none print:border-0 print:p-0">
        {/* Header */}
        <div className="flex items-start justify-between border-b pb-4">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground print:border print:bg-transparent print:text-foreground">
              <Anchor className="size-5" />
            </div>
            <div>
              <div className="text-lg font-bold">{business.business_name}</div>
              {business.address && (
                <div className="text-xs text-muted-foreground">{business.address}</div>
              )}
              {business.phone && (
                <div className="text-xs text-muted-foreground">{business.phone}</div>
              )}
            </div>
          </div>
          <div className="text-right">
            <div className="text-lg font-bold">PAYSLIP</div>
            <div className="font-mono text-sm">{slipNo}</div>
          </div>
        </div>

        {/* Staff + period */}
        <div className="grid grid-cols-2 gap-4 border-b py-4 text-sm">
          <div>
            <div className="text-xs uppercase text-muted-foreground">Employee</div>
            <div className="font-medium">{staff?.full_name}</div>
            <div className="text-muted-foreground">
              {staff?.positions?.title ?? "—"} · {e.shops?.name}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase text-muted-foreground">Pay period</div>
            <div className="font-medium">{period?.label}</div>
            <div className="text-muted-foreground">
              {format(new Date(period?.start_date), "MMM d")} –{" "}
              {format(new Date(period?.end_date), "MMM d, yyyy")}
            </div>
          </div>
        </div>

        {/* Government ID numbers */}
        <div className="border-b py-3">
          <div className="text-xs uppercase text-muted-foreground">
            Government ID numbers
          </div>
          <div className="mt-1 grid grid-cols-3 gap-2 text-sm">
            {govIds.map((g) => (
              <div key={g.label}>
                <div className="text-xs text-muted-foreground">{g.label}</div>
                <div className="font-mono text-xs">
                  {g.value ?? <span className="text-muted-foreground">—</span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Breakdown */}
        <table className="w-full text-sm">
          <tbody>
            <tr className="border-b">
              <td className="py-2.5 text-muted-foreground">Pay type</td>
              <td className="py-2.5 text-right">
                {isDaily ? "Daily rate" : "Monthly salary"}
              </td>
            </tr>
            <tr className="border-b">
              <td className="py-2.5 text-muted-foreground">
                {isDaily ? "Rate per day" : "Monthly salary"}
              </td>
              <td className="py-2.5 text-right tabular-nums">
                {formatCentavos(staff?.pay_rate ?? 0)}
              </td>
            </tr>
            {isDaily && (
              <tr className="border-b">
                <td className="py-2.5 text-muted-foreground">Days worked</td>
                <td className="py-2.5 text-right tabular-nums">
                  {Number(e.days_worked)}
                </td>
              </tr>
            )}
            <tr className="border-b">
              <td className="py-2.5 font-medium">Gross pay</td>
              <td className="py-2.5 text-right font-medium tabular-nums">
                {formatCentavos(e.gross_pay)}
              </td>
            </tr>

            {/* Deduction chain: gross → employee shares → net. */}
            <tr>
              <td colSpan={2} className="pt-3 pb-1 text-xs uppercase text-muted-foreground">
                Less: contributions deducted from your pay
              </td>
            </tr>
            {contributions.length === 0 ? (
              <tr className="border-b">
                <td className="py-2.5 text-muted-foreground" colSpan={2}>
                  {enrolled
                    ? "No government contributions for this pay period."
                    : "Not enrolled — no government contributions deducted."}
                </td>
              </tr>
            ) : (
              AGENCY_ORDER.map((a) => {
                const c = contrib[a];
                if (!c) return null;
                return (
                  <tr key={a} className="border-b">
                    <td className="py-2.5 text-muted-foreground">
                      {AGENCY_LABEL[a]}
                      {/* The MSC is read off the snapshot — never derived here. */}
                      {c.credited_salary_centavos != null && (
                        <span className="ml-1 text-xs">
                          (credited salary{" "}
                          {formatCentavos(c.credited_salary_centavos)})
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 text-right tabular-nums">
                      −{formatCentavos(c.ee_amount_centavos)}
                    </td>
                  </tr>
                );
              })
            )}
            {contributions.length > 0 && (
              <tr className="border-b">
                <td className="py-2.5 text-muted-foreground">Total deductions</td>
                <td className="py-2.5 text-right tabular-nums">
                  −{formatCentavos(totalEE)}
                </td>
              </tr>
            )}

            <tr>
              <td className="py-3 text-base font-semibold">NET PAY</td>
              <td className="py-3 text-right text-base font-bold tabular-nums">
                {formatCentavos(e.net_pay)}
              </td>
            </tr>
          </tbody>
        </table>

        {/* Employer share — deliberately OUTSIDE the deduction chain and after
            NET PAY, so it can never read as money taken from the worker. */}
        {totalER > 0 && (
          <div className="mt-2 rounded-md border border-dashed p-3">
            <div className="text-xs font-medium uppercase text-muted-foreground">
              Employer contributions — paid by {business.business_name}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Remitted for you on top of your pay.{" "}
              <span className="font-medium">Not deducted from your net pay.</span>
            </p>
            <table className="mt-2 w-full text-sm">
              <tbody>
                {AGENCY_ORDER.map((a) => {
                  const c = contrib[a];
                  if (!c) return null;
                  return (
                    <tr key={a}>
                      <td className="py-1 text-muted-foreground">
                        {AGENCY_LABEL[a]}
                      </td>
                      <td className="py-1 text-right tabular-nums">
                        {formatCentavos(c.er_amount_centavos)}
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-t">
                  <td className="py-1 font-medium">Employer total</td>
                  <td className="py-1 text-right font-medium tabular-nums">
                    {formatCentavos(totalER)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-3 flex items-center justify-between border-t pt-3 text-sm">
          <Badge variant={e.status === "paid" ? "default" : "secondary"}>
            {e.status === "paid"
              ? `Paid ${e.date_paid ? format(new Date(e.date_paid), "MMM d, yyyy") : ""}`
              : e.status}
          </Badge>
          <span className="text-xs text-muted-foreground">
            Internal pay record — SSS · PhilHealth · Pag-IBIG only. No tax or
            other deductions.
          </span>
        </div>

        {/* Signatures */}
        <div className="mt-10 grid grid-cols-2 gap-12 text-sm">
          <div className="border-t pt-2 text-center text-muted-foreground">
            Paid by
          </div>
          <div className="border-t pt-2 text-center text-muted-foreground">
            Received by
          </div>
        </div>
      </div>
    </div>
  );
}
