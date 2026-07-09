import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ph_today } from "@/lib/ph-date";
import { PayrollReports, type PayrollReportData } from "./payroll-reports";

export const metadata: Metadata = { title: "Payroll Reports" };

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default async function PayrollReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; shop?: string }>;
}) {
  const params = await searchParams;
  const today = ph_today();
  const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

  const to = isDate(params.to) ? params.to! : today;
  const from = isDate(params.from) ? params.from! : addDays(to, -30);
  const shopFilter = params.shop && params.shop !== "all" ? params.shop : null;

  const supabase = await createClient();

  // periods overlapping the range
  const { data: periods } = await supabase
    .from("pay_periods")
    .select("id, label, start_date, end_date, status")
    .lte("start_date", to)
    .gte("end_date", from)
    .is("deleted_at", null)
    .order("start_date");

  const periodIds = (periods ?? []).map((p) => p.id);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let entries: any[] = [];
  if (periodIds.length > 0) {
    let q = supabase
      .from("payroll_entries")
      .select(
        `id, pay_period_id, staff_id, shop_id, days_worked, net_pay, status, date_paid,
         staff(full_name, pay_type, positions(title)),
         shops(name)`
      )
      .in("pay_period_id", periodIds);
    if (shopFilter) q = q.eq("shop_id", shopFilter);
    const { data } = await q;
    entries = data ?? [];
  }

  const { data: shops } = await supabase
    .from("shops")
    .select("id, name")
    .is("deleted_at", null)
    .order("name");

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const periodLabel = new Map((periods ?? []).map((p) => [p.id, p.label]));

  const rows = entries.map((e: any) => ({
    period: periodLabel.get(e.pay_period_id) ?? "?",
    staff: e.staff?.full_name ?? "?",
    position: e.staff?.positions?.title ?? "—",
    shop: e.shops?.name ?? "?",
    pay_type: e.staff?.pay_type ?? "daily",
    days_worked: Number(e.days_worked),
    net_pay: e.net_pay as number,
    status: e.status as string,
    date_paid: (e.date_paid ?? "") as string,
  }));

  const byShop = new Map<string, { total: number; headcount: Set<string>; paid: number; unpaid: number }>();
  const byPosition = new Map<string, { total: number; headcount: Set<string> }>();
  for (const e of entries) {
    const shopName = e.shops?.name ?? "?";
    const pos = e.staff?.positions?.title ?? "No position";
    const s = byShop.get(shopName) ?? { total: 0, headcount: new Set(), paid: 0, unpaid: 0 };
    s.total += e.net_pay;
    s.headcount.add(e.staff?.full_name ?? e.id);
    if (e.status === "paid") s.paid += e.net_pay;
    else s.unpaid += e.net_pay;
    byShop.set(shopName, s);

    const p = byPosition.get(pos) ?? { total: 0, headcount: new Set() };
    p.total += e.net_pay;
    p.headcount.add(e.staff?.full_name ?? e.id);
    byPosition.set(pos, p);
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const data: PayrollReportData = {
    from,
    to,
    shopFilter: shopFilter ?? "all",
    shops: shops ?? [],
    totals: {
      total: entries.reduce((s, e) => s + e.net_pay, 0),
      paid: entries.filter((e) => e.status === "paid").reduce((s, e) => s + e.net_pay, 0),
      unpaid: entries
        .filter((e) => e.status !== "paid")
        .reduce((s, e) => s + e.net_pay, 0),
      headcount: new Set(entries.map((e) => e.staff_id ?? e.id)).size,
      periods: periodIds.length,
    },
    byShop: [...byShop.entries()].map(([shop, v]) => ({
      shop,
      total: v.total,
      headcount: v.headcount.size,
      paid: v.paid,
      unpaid: v.unpaid,
    })),
    byPosition: [...byPosition.entries()].map(([position, v]) => ({
      position,
      total: v.total,
      headcount: v.headcount.size,
    })),
    rows,
  };

  return <PayrollReports data={data} />;
}
