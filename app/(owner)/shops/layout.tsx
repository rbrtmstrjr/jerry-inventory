import { SectionTabs } from "@/components/shell/section-tabs";

const tabs = [
  { href: "/shops", label: "Shops" },
  { href: "/shops/reports", label: "Reports" },
];

export default function ShopsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Shops &amp; Employees
        </h1>
        <p className="text-sm text-muted-foreground">
          Branches, their login accounts, and how each one performs.
        </p>
      </div>
      <SectionTabs tabs={tabs} />
      {children}
    </div>
  );
}
