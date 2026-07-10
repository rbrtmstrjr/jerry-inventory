import { SectionTabs } from "@/components/shell/section-tabs";

const tabs = [
  { href: "/master-inventory", label: "Products" },
  { href: "/master-inventory/receiving", label: "Receiving" },
  { href: "/master-inventory/bulk-add", label: "Bulk Add" },
  { href: "/master-inventory/labels", label: "Labels" },
  { href: "/master-inventory/suppliers", label: "Suppliers" },
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
          Maccky&apos;s central stock — invisible to shops.
        </p>
      </div>
      <SectionTabs tabs={tabs} />
      {children}
    </div>
  );
}
