import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { Anchor } from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { formatCentavos } from "@/lib/format";
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

  const [entryRes, settingsRes] = await Promise.all([
    supabase
      .from("payroll_entries")
      .select(
        `id, days_worked, gross_pay, net_pay, status, date_paid, note,
         staff(full_name, pay_type, pay_rate, date_hired, positions(title)),
         shops(name, location),
         pay_periods(label, start_date, end_date, frequency)`
      )
      .eq("id", entryId)
      .single(),
    supabase.from("settings").select("business_name, address, phone").eq("id", 1).single(),
  ]);

  const entry = entryRes.data;
  if (!entry) notFound();

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const e = entry as any;
  const settings = settingsRes.data;
  const staff = e.staff;
  const period = e.pay_periods;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const slipNo = `PS-${e.id.slice(0, 8).toUpperCase()}`;
  const isDaily = staff?.pay_type === "daily";

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
              <div className="text-lg font-bold">
                {settings?.business_name ?? "Maccky's Marine"}
              </div>
              {settings?.address && (
                <div className="text-xs text-muted-foreground">{settings.address}</div>
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
              <td className="py-2.5 text-muted-foreground">Gross pay</td>
              <td className="py-2.5 text-right tabular-nums">
                {formatCentavos(e.gross_pay)}
              </td>
            </tr>
            <tr className="border-b">
              <td className="py-2.5 text-muted-foreground">Deductions</td>
              <td className="py-2.5 text-right tabular-nums text-muted-foreground">
                — (none)
              </td>
            </tr>
            <tr>
              <td className="py-3 text-base font-semibold">NET PAY</td>
              <td className="py-3 text-right text-base font-bold tabular-nums">
                {formatCentavos(e.net_pay)}
              </td>
            </tr>
          </tbody>
        </table>

        <div className="flex items-center justify-between border-t pt-3 text-sm">
          <Badge variant={e.status === "paid" ? "default" : "secondary"}>
            {e.status === "paid"
              ? `Paid ${e.date_paid ? format(new Date(e.date_paid), "MMM d, yyyy") : ""}`
              : e.status}
          </Badge>
          <span className="text-xs text-muted-foreground">
            Internal pay record — no government contributions computed.
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
