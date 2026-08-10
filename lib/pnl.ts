import type { SupabaseClient } from "@supabase/supabase-js";

/** The profit math — one implementation, imported by both report tabs so they
 *  can never disagree. Identity + rules: see CLAUDE.md "Per-shop profitability". */

export interface PnlShopRow {
  shop_id: string;
  shop: string;
  closed: boolean;
  revenue: number;
  cogs: number;
  gross_profit: number;
  gross_margin_pct: number;
  /** Shop losses at cost. Context — NOT subtracted from net_contribution. */
  losses: number;
  opex: number;
  net_contribution: number;
  net_margin_pct: number;
  sales_count: number;
  units_sold: number;
  engines_sold: number;
  /** Σ(asking − agreed) on this shop's approved engine sales — margin negotiated away. */
  engine_discount: number;
}

export interface PnlResult {
  from: string;
  to: string;
  perShop: PnlShopRow[];

  // ── the statement ────────────────────────────────────────────────────────
  revenue: number;
  cogs: number;
  grossProfit: number;
  grossMarginPct: number;

  /** Shop losses at cost (nasira/nawala/expired/…), all shops. */
  shopLosses: number;
  /** Stock lost between master and shop. Business-level: no shop ever held it. */
  transitWriteoffs: number;
  /** shopLosses + transitWriteoffs. */
  shrinkage: number;

  shopOpex: number;
  companyOverhead: number;
  opex: number;

  /** Σ per-shop net contribution — the figure /shops/reports headlines. */
  shopNetTotal: number;
  netIncome: number;
  netMarginPct: number;

  // ── cost vs selling ──────────────────────────────────────────────────────
  engineRevenue: number;
  engineCogs: number;
  partRevenue: number;
  partCogs: number;
  /** Σ(asking − agreed) on approved engine lines. What the shops negotiated away. */
  engineDiscount: number;
  engineDiscountLines: number;
  /** Approved engine lines with no asking/agreed recorded (pre-0020). Reported
   *  separately — "unknown" is not the same claim as "zero discount". */
  engineDiscountUnknownLines: number;
}

const pct = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;

/** On a shop session every query SUCCEEDS and just returns less (COGS 0, opex 0),
 *  yielding a net income made only of revenue. Fail loudly instead. */
async function requireOwner(supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase.rpc("is_owner");
  if (error) throw new Error(`Could not verify the caller: ${error.message}`);
  if (!data) throw new Error("Only the owner can compute the P&L");
}

/** Page every row — PostgREST truncates an un-ranged select at 1,000 with no
 *  error. `key` must be UNIQUE, or a page boundary silently drops rows. */
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function fetchAll<T = any>(
  build: () => any,
  key = "id"
): Promise<T[]> {
  // Keyset, not offset — a deep `.range()` walks and discards every prior row
  // and times out. The builder must not set its own order/limit; this owns both.
  const out: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    let page: T[] = [];
    for (let attempt = 1; ; attempt++) {
      let q = build().order(key, { ascending: true }).limit(1000);
      if (cursor !== null) q = q.gt(key, cursor);
      const { data, error } = await q;
      if (!error) {
        page = (data ?? []) as T[];
        break;
      }
      // transient on the shared nano instance — brief backoff, then retry
      if (attempt < 4 && /timeout|pool/i.test(error.message)) {
        await new Promise((r) => setTimeout(r, attempt * 1500));
        continue;
      }
      throw new Error(`Paged query failed: ${error.message}`);
    }
    out.push(...page);
    if (page.length < 1000) return out;
    cursor = (page[page.length - 1] as any)[key];
  }
}

/** Offset paging for tables with no single unique column. Prefer `fetchAll`.
 *  `order` must be a TOTAL ordering or rows repeat/vanish across pages. */
export async function fetchAllOffset<T = any>(
  build: () => any,
  order: string[]
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = build();
    for (const col of order) q = q.order(col, { ascending: true });
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(`Paged query failed: ${error.message}`);
    const page = (data ?? []) as T[];
    out.push(...page);
    if (page.length < 1000) return out;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Money-only activity test. Open shops always get a row; closed ones only when
 *  something happened. Callers with extra context should OR in their own. */
export function pnlHasActivity(r: PnlShopRow): boolean {
  return (
    r.revenue !== 0 ||
    r.cogs !== 0 ||
    r.opex !== 0 ||
    r.losses !== 0
  );
}

type Agg = {
  revenue: number;
  cogs: number;
  losses: number;
  opex: number;
  sales_count: number;
  units_sold: number;
  engines_sold: number;
  engine_discount: number;
};
const zero = (): Agg => ({
  revenue: 0, cogs: 0, losses: 0, opex: 0,
  sales_count: 0, units_sold: 0, engines_sold: 0,
  engine_discount: 0,
});

/** P&L for a PH business-date range. `shopId` filters to one branch; the
 *  consolidated P&L never passes it — overhead belongs to no shop. */
// ── P&L facts: the per-shop + global aggregates the statement is built from ──
interface PnlFacts {
  perShop: Map<string, Agg>;
  engineRevenue: number;
  engineCogs: number;
  partRevenue: number;
  partCogs: number;
  engineDiscountLines: number;
  engineDiscountUnknownLines: number;
  companyOverhead: number;
  transitWriteoffs: number;
}

const numOf = (v: unknown): number =>
  typeof v === "number" ? v : Number((v as string | null) ?? 0);

/* eslint-disable @typescript-eslint/no-explicit-any */
function factsFromRpc(data: any): PnlFacts {
  const perShop = new Map<string, Agg>();
  for (const r of data.per_shop ?? []) {
    perShop.set(r.shop_id, {
      revenue: numOf(r.revenue),
      cogs: numOf(r.cogs),
      losses: numOf(r.losses),
      opex: numOf(r.opex),
      sales_count: numOf(r.sales_count),
      units_sold: numOf(r.units_sold),
      engines_sold: numOf(r.engines_sold),
      engine_discount: numOf(r.engine_discount),
    });
  }
  return {
    perShop,
    engineRevenue: numOf(data.engine_revenue),
    engineCogs: numOf(data.engine_cogs),
    partRevenue: numOf(data.part_revenue),
    partCogs: numOf(data.part_cogs),
    engineDiscountLines: numOf(data.engine_discount_lines),
    engineDiscountUnknownLines: numOf(data.engine_discount_unknown_lines),
    companyOverhead: numOf(data.company_overhead),
    transitWriteoffs: numOf(data.transit_writeoffs),
  };
}

/** O(transactions) row-walk: the fallback before 0075 is applied, and the
 *  reference the SQL path is proven byte-identical against. */
async function factsFromRowWalk(
  supabase: SupabaseClient,
  from: string,
  to: string,
  scope: Set<string>
): Promise<PnlFacts> {
  const [allSales, allLosses, allShopExpenses, allCompanyExpenses, allTransit] =
    await Promise.all([
      fetchAll(() =>
        supabase
          .from("sales")
          .select(
            `id, shop_id, total_centavos,
             sale_lines(id, qty, engine_id, line_total_centavos,
                        agreed_price_centavos, list_reference_centavos, discount_centavos),
             sale_line_costs(sale_line_id, line_cost_centavos)`
          )
          .eq("status", "approved")
          .gte("business_date", from)
          .lte("business_date", to)
          .is("deleted_at", null)
      ),
      fetchAll(() =>
        supabase
          .from("losses")
          .select("id, shop_id, value_centavos")
          .eq("status", "approved")
          .gte("business_date", from)
          .lte("business_date", to)
          .is("deleted_at", null)
      ),
      fetchAll(() =>
        supabase
          .from("expenses")
          .select("id, shop_id, amount")
          .eq("scope", "shop")
          .eq("status", "approved")
          .gte("expense_date", from)
          .lte("expense_date", to)
          .is("deleted_at", null)
      ),
      fetchAll(() =>
        supabase
          .from("expenses")
          .select("id, amount")
          .eq("scope", "company")
          .eq("status", "approved")
          .gte("expense_date", from)
          .lte("expense_date", to)
          .is("deleted_at", null)
      ),
      fetchAll(() =>
        supabase
          .from("stock_movements")
          .select("id, qty_change, parts(cost_centavos), engines(cost_centavos)")
          .eq("movement_type", "transit_writeoff")
          // Anchor to PH time (+08:00) so created_at matches by PH calendar day,
          // like business_date. UTC-midnight bounds dropped morning write-offs.
          .gte("created_at", `${from}T00:00:00+08:00`)
          .lte("created_at", `${to}T23:59:59.999+08:00`)
      ),
    ]);

  const agg = new Map<string, Agg>([...scope].map((id) => [id, zero()]));
  const bump = (id: string | null, fn: (a: Agg) => void) => {
    if (!id) return;
    const a = agg.get(id);
    if (a) fn(a);
  };

  let engineRevenue = 0;
  let engineCogs = 0;
  let partRevenue = 0;
  let partCogs = 0;
  let engineDiscountLines = 0;
  let engineDiscountUnknownLines = 0;

  for (const s of allSales as any[]) {
    bump(s.shop_id, (a) => {
      a.revenue += s.total_centavos ?? 0;
      a.sales_count += 1;
      for (const c of s.sale_line_costs ?? []) a.cogs += c.line_cost_centavos ?? 0;

      const costByLine = new Map<string, number>();
      for (const c of s.sale_line_costs ?? [])
        costByLine.set(c.sale_line_id, c.line_cost_centavos ?? 0);

      for (const l of s.sale_lines ?? []) {
        const cost = costByLine.get(l.id) ?? 0;
        const rev = l.line_total_centavos ?? 0;
        if (!l.engine_id) {
          a.units_sold += l.qty;
          partRevenue += rev;
          partCogs += cost;
          continue;
        }
        a.engines_sold += 1;
        engineRevenue += rev;
        engineCogs += cost;
        const d =
          l.discount_centavos ??
          (l.list_reference_centavos != null && l.agreed_price_centavos != null
            ? l.list_reference_centavos - l.agreed_price_centavos
            : null);
        if (d == null) {
          engineDiscountUnknownLines += 1;
        } else {
          a.engine_discount += d;
          engineDiscountLines += 1;
        }
      }
    });
  }
  for (const l of allLosses as any[]) bump(l.shop_id, (a) => (a.losses += l.value_centavos ?? 0));
  for (const e of allShopExpenses as any[]) bump(e.shop_id, (a) => (a.opex += e.amount));

  const companyOverhead = (allCompanyExpenses as any[]).reduce((t, e) => t + (e.amount ?? 0), 0);
  const transitWriteoffs = (allTransit as any[]).reduce((t, m) => {
    const unitCost = m.parts?.cost_centavos ?? m.engines?.cost_centavos ?? 0;
    return t + Math.abs(m.qty_change ?? 0) * unitCost;
  }, 0);

  return {
    perShop: agg,
    engineRevenue,
    engineCogs,
    partRevenue,
    partCogs,
    engineDiscountLines,
    engineDiscountUnknownLines,
    companyOverhead,
    transitWriteoffs,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** SQL fast path (fn_pnl_facts, 0075), falling back to the row-walk if the
 *  migration isn't applied. test-pnl asserts the two are byte-identical. */
async function gatherFacts(
  supabase: SupabaseClient,
  from: string,
  to: string,
  shopId: string | null
): Promise<PnlFacts> {
  const { data, error } = await supabase.rpc("fn_pnl_facts", {
    p_from: from,
    p_to: to,
    p_shop_id: shopId,
  });
  if (!error && data) return factsFromRpc(data);

  // fallback needs the in-scope shop ids to seed the per-shop map
  const { data: shopRows } = await supabase.from("shops").select("id, deleted_at");
  const scope = new Set(
    (shopRows ?? [])
      .filter((s) => !shopId || s.id === shopId)
      .map((s) => s.id as string)
  );
  return factsFromRowWalk(supabase, from, to, scope);
}

export async function computePnl(
  supabase: SupabaseClient,
  { from, to, shopId = null }: { from: string; to: string; shopId?: string | null }
): Promise<PnlResult> {
  await requireOwner(supabase);

  // No deleted_at filter, on purpose — closed shops still count (see header).
  const shopsRes = await supabase.from("shops").select("id, name, deleted_at").order("name");
  const allShops = shopsRes.data ?? [];
  const shops = allShops.filter((s) => !shopId || s.id === shopId);

  const f = await gatherFacts(supabase, from, to, shopId);

  const perShop: PnlShopRow[] = shops.map((s) => {
    const a = f.perShop.get(s.id) ?? zero();
    const gross_profit = a.revenue - a.cogs;
    // Losses are NOT subtracted here — a shop's contribution is judged on what
    // it sold; shrinkage is the business's problem and lands in net income.
    const net_contribution = gross_profit - a.opex;
    return {
      shop_id: s.id,
      shop: s.name,
      closed: !!s.deleted_at,
      ...a,
      gross_profit,
      gross_margin_pct: pct(gross_profit, a.revenue),
      net_contribution,
      net_margin_pct: pct(net_contribution, a.revenue),
    };
  });

  const sum = (k: keyof PnlShopRow) =>
    perShop.reduce((t, r) => t + ((r[k] as number) ?? 0), 0);

  const revenue = sum("revenue");
  const cogs = sum("cogs");
  const grossProfit = revenue - cogs;
  const shopLosses = sum("losses");
  const transitWriteoffs = f.transitWriteoffs;
  const shrinkage = shopLosses + transitWriteoffs;
  const shopOpex = sum("opex");
  const companyOverhead = f.companyOverhead;
  const shopNetTotal = sum("net_contribution");
  const netIncome = grossProfit - shrinkage - shopOpex - companyOverhead;

  return {
    from,
    to,
    perShop,
    revenue,
    cogs,
    grossProfit,
    grossMarginPct: pct(grossProfit, revenue),
    shopLosses,
    transitWriteoffs,
    shrinkage,
    shopOpex,
    companyOverhead,
    opex: shopOpex + companyOverhead,
    shopNetTotal,
    netIncome,
    netMarginPct: pct(netIncome, revenue),
    engineRevenue: f.engineRevenue,
    engineCogs: f.engineCogs,
    partRevenue: f.partRevenue,
    partCogs: f.partCogs,
    engineDiscount: sum("engine_discount"),
    engineDiscountLines: f.engineDiscountLines,
    engineDiscountUnknownLines: f.engineDiscountUnknownLines,
  };
}
// Cash vs accrual: net income is EARNED, this is what ARRIVED. Never let one
// stand in for the other — a month can earn ₱200k and collect ₱40k.
export interface CashPosition {
  /** Approved sales value in range (accrual) — ties to PnlResult.revenue. */
  earned: number;
  /** Cash in during range: money taken at the till + utang payments collected. */
  collected: number;
  /** Utang still owed right now. A balance as of today, NOT a range figure. */
  outstanding: number;
  /** What we owe suppliers right now. Balance-sheet context, not P&L. */
  supplierPayables: number;
}

export async function computeCashPosition(
  supabase: SupabaseClient,
  { from, to }: { from: string; to: string }
): Promise<CashPosition> {
  // Same reasoning as computePnl — a shop reads its own sales and receivables,
  // so this would return one branch's position and call it the business's.
  await requireOwner(supabase);

  const [sales, allPayments, allReceivables, payablesRes] = await Promise.all([
    fetchAll(() =>
      supabase
        .from("sales")
        .select("id, payment_type, total_centavos, amount_paid_centavos")
        .eq("status", "approved")
        .gte("business_date", from)
        .lte("business_date", to)
        .is("deleted_at", null)
    ),

    // `business_date` — utang_payments has no paid_on. Voided payments are
    // soft-deleted, so they drop out of cash-in on their own.
    fetchAll(() =>
      supabase
        .from("utang_payments")
        .select("id, amount_centavos")
        .eq("status", "approved")
        .gte("business_date", from)
        .lte("business_date", to)
        .is("deleted_at", null)
    ),

    fetchAll(
      () => supabase.from("receivables").select("sale_id, balance_centavos"),
      "sale_id"
    ),

    // one row per supplier — cannot outgrow the page size
    supabase.from("supplier_payables").select("outstanding"),
  ]);
  const earned = sales.reduce((t, s) => t + (s.total_centavos ?? 0), 0);

  // NOT Σ amount_paid_centavos — it is NULL on full sales predating 0020, which
  // books them as ₱0 collected. A full sale's total IS the cash.
  const atSale = sales.reduce(
    (t, s) =>
      t +
      (s.payment_type === "partial"
        ? (s.amount_paid_centavos ?? 0)
        : (s.total_centavos ?? 0)),
    0
  );
  const since = allPayments.reduce(
    (t, p) => t + (p.amount_centavos ?? 0),
    0
  );

  return {
    earned,
    collected: atSale + since,
    outstanding: allReceivables.reduce(
      (t, r) => t + Math.max(0, r.balance_centavos ?? 0),
      0
    ),
    supplierPayables: (payablesRes.data ?? []).reduce(
      (t, p) => t + (p.outstanding ?? 0),
      0
    ),
  };
}
