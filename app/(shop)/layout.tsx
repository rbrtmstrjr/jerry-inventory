import { requireEmployee } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/shell/app-shell";

export default async function ShopLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await requireEmployee();

  // Shop name + the three sidebar badge counts, in ONE server round-trip.
  //
  // Unlike the owner side (whose counts are expensive all-shops views, so its
  // badges fetch client-side via a batched RPC), the shop counts are scoped to
  // this ONE shop — cheap. Computing them here (fast server↔DB link) and seeding
  // them into the first paint means the shop badges are correct instantly, with
  // NO slow-wifi client round-trips trickling in. They still refresh live via
  // their realtime/focus subscriptions once mounted.
  let shopName = "My Shop";
  let badgeCounts: Record<string, number> | undefined;
  if (profile.shop_id) {
    const supabase = await createClient();
    const head = { count: "exact" as const, head: true };
    const [nameRes, delRes, lowRes, recRes] = await Promise.all([
      supabase.from("shops").select("name").eq("id", profile.shop_id).single(),
      supabase
        .from("shop_incoming_deliveries")
        .select("*", head)
        .eq("status", "in_transit"),
      supabase.from("shop_low_stock_safe").select("*", head),
      supabase
        .from("shop_receivables")
        .select("*", head)
        .gt("balance_centavos", 0),
    ]);
    if (nameRes.data?.name) shopName = nameRes.data.name;
    badgeCounts = {
      "/shop/deliveries": delRes.count ?? 0,
      "/shop/low-stock": lowRes.count ?? 0,
      "/shop/receivables": recRes.count ?? 0,
    };
  }

  return (
    <AppShell
      variant="employee"
      userName={profile.full_name}
      contextLabel={shopName}
      badgeCounts={badgeCounts}
    >
      {children}
    </AppShell>
  );
}
