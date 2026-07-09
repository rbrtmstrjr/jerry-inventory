import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ShopsView, type EmployeeRow, type ShopRow } from "./shops-view";

export const metadata: Metadata = { title: "Shops & Employees" };

export default async function ShopsPage() {
  const supabase = await createClient();

  const [shopsRes, profilesRes, stockRes, enginesRes, pendSalesRes, pendLossesRes] = await Promise.all([
    supabase
      .from("shops")
      .select("id, name, location, active")
      .is("deleted_at", null)
      .order("name"),
    supabase
      .from("profiles")
      .select("id, full_name, role, shop_id, active, shops(name)")
      .is("deleted_at", null)
      .order("full_name"),
    supabase
      .from("stock_levels")
      .select("shop_id, qty")
      .not("shop_id", "is", null)
      .gt("qty", 0),
    supabase
      .from("engines")
      .select("shop_id")
      .eq("status", "delivered")
      .is("deleted_at", null),
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
  ]);

  // per-shop stock summaries
  const unitsByShop: Record<string, number> = {};
  for (const r of stockRes.data ?? []) {
    unitsByShop[r.shop_id!] = (unitsByShop[r.shop_id!] ?? 0) + r.qty;
  }
  const enginesByShop: Record<string, number> = {};
  for (const e of enginesRes.data ?? []) {
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

  return <ShopsView shops={shops} employees={employees} />;
}
