import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { StaffView, type StaffRow, type PositionOption } from "./staff-view";

export const metadata: Metadata = { title: "Staff" };

export default async function StaffPage() {
  const supabase = await createClient();

  const [staffRes, shopsRes, positionsRes] = await Promise.all([
    supabase
      .from("staff")
      .select(
        `id, full_name, shop_id, position_id, pay_type, pay_rate, date_hired, active, notes,
         sss_no, philhealth_no, pagibig_no, contributions_enabled,
         shops(name), positions(title)`
      )
      .is("deleted_at", null)
      .order("full_name"),
    supabase.from("shops").select("id, name").is("deleted_at", null).order("name"),
    supabase
      .from("positions")
      .select("id, title, shop_id, default_pay_rate")
      .eq("active", true)
      .is("deleted_at", null)
      .order("title"),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const staff: StaffRow[] = (staffRes.data ?? []).map((s: any) => ({
    id: s.id,
    full_name: s.full_name,
    shop_id: s.shop_id,
    shop_name: s.shops?.name ?? "?",
    position_id: s.position_id,
    position: s.positions?.title ?? null,
    pay_type: s.pay_type,
    pay_rate: s.pay_rate,
    date_hired: s.date_hired,
    active: s.active,
    notes: s.notes,
    sss_no: s.sss_no,
    philhealth_no: s.philhealth_no,
    pagibig_no: s.pagibig_no,
    contributions_enabled: s.contributions_enabled,
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <StaffView
      staff={staff}
      shops={shopsRes.data ?? []}
      positions={(positionsRes.data ?? []) as PositionOption[]}
    />
  );
}
