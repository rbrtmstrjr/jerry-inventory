import { requireEmployee } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/shell/app-shell";

export default async function ShopLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await requireEmployee();

  // Shop name for the header/context label (falls back until shops exist).
  let shopName = "My Shop";
  if (profile.shop_id) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("shops")
      .select("name")
      .eq("id", profile.shop_id)
      .single();
    if (data?.name) shopName = data.name;
  }

  return (
    <AppShell
      variant="employee"
      userName={profile.full_name}
      contextLabel={shopName}
    >
      {children}
    </AppShell>
  );
}
