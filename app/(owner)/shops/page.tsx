import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/pnl";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ShopsView, type EmployeeRow, type ShopRow } from "./shops-view";

export const metadata: Metadata = { title: "Shops & Employees" };

/** Shell: the layout's heading stays instant; the shop cards (which page every
 *  shop's stock + engines) stream in behind a skeleton. */
export default function ShopsPage() {
  return (
    <Suspense fallback={<ShopsSkeleton />}>
      <ShopsBody />
    </Suspense>
  );
}

async function ShopsBody() {
  const supabase = await createClient();

  const [shopsRes, profilesRes, allStock, allEngines, pendSalesRes, pendLossesRes, staffRes] = await Promise.all([
    supabase
      .from("shops")
      .select("id, name, location, latitude, longitude, active, color_key, logo_path")
      .is("deleted_at", null)
      .order("name"),
    supabase
      .from("profiles")
      .select("id, full_name, role, shop_id, active, shops(name)")
      .is("deleted_at", null)
      .order("full_name"),
    // Paginated: one row per (part, shop) — 400 parts × N shops outgrows the
    // 1,000-row cap, which was silently zeroing the units count for whichever
    // shops fell past row 1,000.
    fetchAll<{ id: string; shop_id: string | null; qty: number }>(
      () => supabase.from("stock_levels").select("id, shop_id, qty").not("shop_id", "is", null).gt("qty", 0),
      "id"
    ),
    // one row per on-hand engine across every shop — likewise page it.
    fetchAll<{ id: string; shop_id: string | null }>(
      () => supabase.from("engines").select("id, shop_id").eq("status", "delivered").is("deleted_at", null),
      "id"
    ),
    supabase
      .from("sales")
      .select("shop_id")
      .in("status", ["pending", "questioned"])
      .is("deleted_at", null),
    supabase
      .from("losses")
      .select("shop_id")
      .in("status", ["pending", "questioned"])
      .is("deleted_at", null),
    // payroll staff (the actual people) — shown per shop card
    supabase
      .from("staff")
      .select("id, full_name, shop_id, active, positions(title)")
      .is("deleted_at", null)
      .order("full_name"),
  ]);

  // per-shop stock summaries
  const unitsByShop: Record<string, number> = {};
  for (const r of allStock) {
    unitsByShop[r.shop_id!] = (unitsByShop[r.shop_id!] ?? 0) + r.qty;
  }
  const enginesByShop: Record<string, number> = {};
  for (const e of allEngines) {
    if (e.shop_id) enginesByShop[e.shop_id] = (enginesByShop[e.shop_id] ?? 0) + 1;
  }
  const pendingByShop: Record<string, number> = {};
  for (const r of [...(pendSalesRes.data ?? []), ...(pendLossesRes.data ?? [])]) {
    pendingByShop[r.shop_id] = (pendingByShop[r.shop_id] ?? 0) + 1;
  }

  // emails live in auth.users — fetch via admin (server-side, owner page)
  const emailById = new Map<string, string>();
  try {
    const admin = createAdminClient();
    const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
    for (const u of data?.users ?? []) emailById.set(u.id, u.email ?? "");
  } catch {
    // service key missing — page still renders without emails
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const employees: EmployeeRow[] = (profilesRes.data ?? []).map((p: any) => ({
    id: p.id,
    full_name: p.full_name,
    role: p.role,
    shop_id: p.shop_id,
    shop_name: p.shops?.name ?? null,
    active: p.active,
    email: emailById.get(p.id) ?? "",
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const shops: ShopRow[] = (shopsRes.data ?? []).map((s) => ({
    ...s,
    part_units: unitsByShop[s.id] ?? 0,
    engine_count: enginesByShop[s.id] ?? 0,
    pending_count: pendingByShop[s.id] ?? 0,
  }));

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const staff = (staffRes.data ?? []).map((s: any) => ({
    id: s.id as string,
    full_name: s.full_name as string,
    shop_id: s.shop_id as string,
    active: s.active as boolean,
    position: (s.positions?.title ?? null) as string | null,
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return <ShopsView shops={shops} employees={employees} staff={staff} />;
}

function ShopsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-72" />
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-5 w-40" />
              <Skeleton className="mt-2 h-3 w-56" />
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-16 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
