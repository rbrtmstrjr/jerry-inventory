import { createClient } from "@/lib/supabase/server";
import { computeCashPosition, computePnl, pnlHasActivity } from "@/lib/pnl";
import { PnlView, type PnlViewData } from "./pnl-view";

/** UTC arithmetic on a pure date string — no timezone can shift a calendar day. */
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function daysInclusive(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.floor((b - a) / 86400000) + 1;
}
function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}
function monthEnd(iso: string): string {
  const d = new Date(`${monthStart(iso)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}
function nextMonth(iso: string): string {
  const d = new Date(`${monthStart(iso)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

/** A month is the smallest honest bucket for net income — see the note below. */
const MAX_MONTH_BUCKETS = 12;

export async function PnlTab({ from, to }: { from: string; to: string }) {
  const supabase = await createClient();

  // The period immediately before this one, same length. "Up ₱40k on last
  // month" is the question every owner actually asks of a P&L.
  const len = daysInclusive(from, to);
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(len - 1));

  // Net income is bucketed by MONTH, never by day.
  //
  // Payroll lands on pay periods and overhead arrives as monthly bills, so a
  // daily net-income line would have to spread them across days — inventing a
  // shape the data does not have. That is the same "allocation is fiction"
  // rule that keeps company overhead out of the shops. A month is the smallest
  // period where every term of the statement is genuinely present.
  const months: { from: string; to: string; label: string }[] = [];
  for (
    let m = monthStart(from);
    m <= to && months.length < MAX_MONTH_BUCKETS;
    m = nextMonth(m)
  ) {
    months.push({
      from: m > from ? m : from,
      to: monthEnd(m) < to ? monthEnd(m) : to,
      label: m.slice(0, 7),
    });
  }
  const monthsTruncated = nextMonth(months[months.length - 1]?.from ?? from) <= to;

  const [pnl, prev, cash, expenseRowsRes, monthly] = await Promise.all([
    computePnl(supabase, { from, to }),
    computePnl(supabase, { from: prevFrom, to: prevTo }),
    computeCashPosition(supabase, { from, to }),
    supabase
      .from("expenses")
      .select("amount, scope, expense_categories(name)")
      .gte("expense_date", from)
      .lte("expense_date", to)
      .is("deleted_at", null),
    // Only worth the queries when the range actually spans more than one month.
    months.length > 1
      ? Promise.all(
          months.map((m) =>
            computePnl(supabase, { from: m.from, to: m.to }).then((r) => ({
              label: m.label,
              netIncome: r.netIncome,
              revenue: r.revenue,
              grossProfit: r.grossProfit,
            }))
          )
        )
      : Promise.resolve([]),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const byCategory = new Map<string, number>();
  for (const e of (expenseRowsRes.data ?? []) as any[]) {
    const name = e.expense_categories?.name ?? "Uncategorised";
    byCategory.set(name, (byCategory.get(name) ?? 0) + (e.amount ?? 0));
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const data: PnlViewData = {
    from,
    to,
    prevFrom,
    prevTo,
    pnl,
    prev: {
      netIncome: prev.netIncome,
      revenue: prev.revenue,
      grossProfit: prev.grossProfit,
      cogs: prev.cogs,
      shrinkage: prev.shrinkage,
      opex: prev.opex,
      laborCost: prev.laborCost,
      netMarginPct: prev.netMarginPct,
    },
    cash,
    expenseByCategory: [...byCategory.entries()]
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount),
    monthly,
    monthsTruncated,
    // Idle branches are noise on an income statement. An open shop with no
    // activity contributes nothing to a single line of it.
    perShop: pnl.perShop.filter(pnlHasActivity),
  };

  return <PnlView data={data} />;
}
