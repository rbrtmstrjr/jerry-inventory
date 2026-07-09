import { Info } from "lucide-react";
import { SectionTabs } from "@/components/shell/section-tabs";

const tabs = [
  { href: "/expenses", label: "Expenses" },
  { href: "/expenses/categories", label: "Categories" },
  { href: "/expenses/reports", label: "Reports" },
];

export default function ExpensesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Operating Expenses
        </h1>
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Info className="size-3.5" />
          Fuel, pakyaw, utilities, rent, misc — NOT stock purchases (Receiving),
          wages (Payroll), or nasira (Losses).
        </p>
      </div>
      <SectionTabs tabs={tabs} />
      {children}
    </div>
  );
}
