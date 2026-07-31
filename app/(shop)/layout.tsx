import { requireEmployee } from "@/lib/auth";
import { getShopBadgeCounts } from "@/lib/shop-nav";
import { AppShell } from "@/components/shell/app-shell";

export default async function ShopLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await requireEmployee();
  const { shopName, badges } = await getShopBadgeCounts(profile.shop_id);
  return (
    <AppShell variant="employee" userName={profile.full_name} contextLabel={shopName} badgeCounts={badges}>
      {children}
    </AppShell>
  );
}
