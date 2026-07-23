import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { ph_today } from "@/lib/ph-date";
import { ReportSkeleton } from "@/components/shell/streaming-skeletons";
import { PayrollReports, type PayrollReportData } from "./payroll-reports";

export const metadata: Metadata = { title: "Payroll Reports" };

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Shell: the layout's heading + tabs stay instant; the report streams behind a
 *  skeleton that re-shows whenever the filters change. */
export default async function PayrollReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; shop?: string }>;
}) {
  const params = await searchParams;
  return (
    <Suspense key={JSON.stringify(params)} fallback={<ReportSkeleton />}>
      <PayrollReportsBody params={params} />
    </Suspense>
  );
}

async function PayrollReportsBody({
  params,
}: {
  params: { from?: string; to?: string; shop?: string };
}) {
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
         shops(name, color_key)`
      )
      .in("pay_period_id", periodIds);
    if (shopFilter) q = q.eq("shop_id", shopFilter);
    const { data } = await q;
    entries = data ?? [];
  }

  const { data: shops } = await supabase
    .from("shops")
    .select("id, name, color_key")
    .is("deleted_at", null)
    .order("name");

  // ---------------------------------------------------------------------------
  // Government remittances (SSS / PhilHealth / Pag-IBIG)
  //
  // Read straight from the frozen `payroll_entry_contributions` snapshot — the
  // amounts are never recomputed here, so editing the rate book next year can't
  // rewrite what was already remitted. No rate, bracket or threshold is known to
  // this file; it only adds up centavos the database already decided.
  // ---------------------------------------------------------------------------
  type RemitRow = {
    period_id: string;
    agency: string;
    staff_count: number;
    ee: number;
    er: number;
    total: number;
  };

  let remit: RemitRow[] = [];
  if (periodIds.length === 1 && !shopFilter) {
    // Canonical path: fn_remittance_totals IS the definition of the number handed
    // to the agency. It takes no shop argument, so it can only serve the
    // unfiltered single-period case — the branch below sums the same snapshot
    // rows for everything else.
    const { data } = await supabase.rpc("fn_remittance_totals", {
      p_period_id: periodIds[0],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    remit = ((data ?? []) as any[]).map((r) => ({
      period_id: periodIds[0],
      agency: r.agency as string,
      staff_count: Number(r.staff_count),
      ee: Number(r.ee_total_centavos),
      er: Number(r.er_total_centavos),
      total: Number(r.total_centavos),
    }));
  } else if (periodIds.length > 0) {
    let q = supabase
      .from("payroll_entry_contributions")
      .select(
        "agency, ee_amount_centavos, er_amount_centavos, payroll_entries!inner(pay_period_id, shop_id)"
      )
      .in("payroll_entries.pay_period_id", periodIds);
    if (shopFilter) q = q.eq("payroll_entries.shop_id", shopFilter);
    const { data } = await q;

    const acc = new Map<string, RemitRow>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const c of (data ?? []) as any[]) {
      const pid = c.payroll_entries.pay_period_id as string;
      const key = `${pid}|${c.agency}`;
      const row = acc.get(key) ?? {
        period_id: pid,
        agency: c.agency as string,
        staff_count: 0,
        ee: 0,
        er: 0,
        total: 0,
      };
      // unique(payroll_entry_id, agency) — one row per entry per agency, so a row
      // IS one staff member on that period's remittance.
      row.staff_count += 1;
      row.ee += c.ee_amount_centavos ?? 0;
      row.er += c.er_amount_centavos ?? 0;
      row.total += (c.ee_amount_centavos ?? 0) + (c.er_amount_centavos ?? 0);
      acc.set(key, row);
    }
    remit = [...acc.values()];
  }

  // Enum declaration order — the same order fn_remittance_totals returns.
  const AGENCY_ORDER = ["sss", "philhealth", "pagibig"];
  const periodMeta = new Map(
    (periods ?? []).map((p) => [p.id, { label: p.label, start: p.start_date }])
  );
  remit.sort(
    (a, b) =>
      (periodMeta.get(a.period_id)?.start ?? "").localeCompare(
        periodMeta.get(b.period_id)?.start ?? ""
      ) || AGENCY_ORDER.indexOf(a.agency) - AGENCY_ORDER.indexOf(b.agency)
  );

  // Group into what the owner actually remits: one bundle per period.
  const remitPeriods: PayrollReportData["remittance"]["periods"] = [];
  for (const r of remit) {
    let g = remitPeriods.find((p) => p.period_id === r.period_id);
    if (!g) {
      g = {
        period_id: r.period_id,
        period: periodMeta.get(r.period_id)?.label ?? "?",
        agencies: [],
        ee: 0,
        er: 0,
        total: 0,
      };
      remitPeriods.push(g);
    }
    g.agencies.push({
      agency: r.agency,
      staff_count: r.staff_count,
      ee: r.ee,
      er: r.er,
      total: r.total,
    });
    g.ee += r.ee;
    g.er += r.er;
    g.total += r.total;
  }

  // Range roll-up per agency. Deliberately carries no staff count: across several
  // periods "staff" would either double-count people or stop summing down the
  // column. The money is the point here.
  const remitByAgency = AGENCY_ORDER.map((agency) => {
    const rows = remit.filter((r) => r.agency === agency);
    return {
      agency,
      ee: rows.reduce((s, r) => s + r.ee, 0),
      er: rows.reduce((s, r) => s + r.er, 0),
      total: rows.reduce((s, r) => s + r.total, 0),
    };
  }).filter((a) => a.total > 0);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const periodLabel = new Map((periods ?? []).map((p) => [p.id, p.label]));

  const rows = entries.map((e: any) => ({
    period: periodLabel.get(e.pay_period_id) ?? "?",
    staff: e.staff?.full_name ?? "?",
    position: e.staff?.positions?.title ?? "—",
    shop: e.shops?.name ?? "?",
    shop_color_key: (e.shops?.color_key ?? null) as string | null,
    pay_type: e.staff?.pay_type ?? "daily",
    days_worked: Number(e.days_worked),
    net_pay: e.net_pay as number,
    status: e.status as string,
    date_paid: (e.date_paid ?? "") as string,
  }));

  const byShop = new Map<string, { color_key: string | null; total: number; headcount: Set<string>; paid: number; unpaid: number }>();
  const byPosition = new Map<string, { total: number; headcount: Set<string> }>();
  for (const e of entries) {
    const shopName = e.shops?.name ?? "?";
    const pos = e.staff?.positions?.title ?? "No position";
    const s = byShop.get(shopName) ?? {
      color_key: (e.shops?.color_key ?? null) as string | null,
      total: 0,
      headcount: new Set(),
      paid: 0,
      unpaid: 0,
    };
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
      color_key: v.color_key,
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
    remittance: {
      periods: remitPeriods,
      byAgency: remitByAgency,
      totals: {
        ee: remit.reduce((s, r) => s + r.ee, 0),
        er: remit.reduce((s, r) => s + r.er, 0),
        total: remit.reduce((s, r) => s + r.total, 0),
      },
      // A shop-filtered figure is NOT the amount handed to the agency — the
      // agency is remitted for the whole business at once. Say so rather than
      // let a filtered number be mistaken for the real one.
      shopFiltered: !!shopFilter,
    },
    rows,
  };

  return <PayrollReports data={data} />;
}
