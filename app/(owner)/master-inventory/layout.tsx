import { SectionTabs } from "@/components/shell/section-tabs";

// Suppliers moved to /suppliers — stock starts at a supplier, so they head the
// INVENTORY sidebar group instead of hiding inside Master Inventory. The old
// route redirects.
const tabs = [
  { href: "/master-inventory", label: "Products" },
  { href: "/master-inventory/receiving", label: "Receiving" },
  { href: "/master-inventory/bulk-add", label: "Bulk Add" },
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
