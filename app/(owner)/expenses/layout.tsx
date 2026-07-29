import { Info } from "lucide-react";
import { SectionTabs } from "@/components/shell/section-tabs";
import { requireOwner } from "@/lib/auth";

export default async function ExpensesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Recording expenses is daily office work; the REPORTS tab (spending
  // overview) is Gerry-only (0099), so the admin doesn't get its tab.
  const profile = await requireOwner();
  const tabs = [
    { href: "/expenses", label: "Expenses" },
    { href: "/expenses/categories", label: "Categories" },
    ...(profile.role === "owner"
      ? [{ href: "/expenses/reports", label: "Reports" }]
      : []),
  ];
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Operating Expenses
        </h1>
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Info className="size-3.5" />
          Fuel, pakyaw, wages, utilities, rent, misc — NOT stock purchases
          (Receiving) or nasira (Losses).
        </p>
      </div>
      <SectionTabs tabs={tabs} />
      {children}
    </div>
  );
}
