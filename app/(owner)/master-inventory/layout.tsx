import { SectionTabs } from "@/components/shell/section-tabs";

// Master Inventory is view + edit only — products land here because a
// supplier delivered them. Receiving moved to /suppliers?tab=receiving (it's
// a supplier transaction); Bulk Add was retired by 0048. Both old routes
// redirect.
const tabs = [
  { href: "/master-inventory", label: "Products" },
  { href: "/master-inventory/categories", label: "Category" },
  { href: "/master-inventory/labels", label: "Labels" },
];

export default function MasterInventoryLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Master Inventory
        </h1>
        <p className="text-sm text-muted-foreground">
          Admin&apos;s central stock — invisible to shops.
        </p>
      </div>
      <SectionTabs tabs={tabs} />
      {children}
    </div>
  );
}
