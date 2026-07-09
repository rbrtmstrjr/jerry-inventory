import { Info } from "lucide-react";
import { SectionTabs } from "@/components/shell/section-tabs";

const tabs = [
  { href: "/payroll", label: "Run Payroll" },
  { href: "/payroll/staff", label: "Staff" },
  { href: "/payroll/positions", label: "Positions" },
  { href: "/payroll/reports", label: "Reports" },
];

export default function PayrollLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Payroll</h1>
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Info className="size-3.5" />
          Internal pay tracking — does not compute government contributions or
          taxes.
        </p>
      </div>
      <SectionTabs tabs={tabs} />
      {children}
    </div>
  );
}
