import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The business's profit math — ONE implementation, two pages.
 *
 * NO `server-only` here, deliberately, unlike lib/business-identity.ts. This
 * module holds no secret and opens no connection: it takes the caller's client
 * as a parameter and is otherwise pure. Its guard is RLS — every table it reads
 * is owner-only, so an anon client would simply see nothing.
 *
 * What that buys is worth more than the guard: `scripts/test-pnl.mjs` imports
 * this file directly and asserts against THE CODE BOTH PAGES RUN, rather than
 * scraping numbers out of rendered HTML or re-deriving the arithmetic in the
 * test — a second implementation of the math is exactly the drift this module
 * exists to prevent, and a test that reimplements it proves nothing.
 *
 * `/shops/reports` (per-shop contribution) and `/reports?tab=pnl` (consolidated
 * P&L) are the same numbers looked at from two directions. They were never
 * allowed to disagree, so they must not be computed twice: this module is the
 * single source, and both pages import it.
 *
 * ---------------------------------------------------------------------------
 * THE IDENTITY THAT HOLDS THIS TOGETHER
 *
 *   Σ shop net contribution − company overhead − shrinkage = net income
 *
 * Note the shrinkage term. The spec for this feature asserted
 * `Σ shop net − overhead = net income` exactly, which is arithmetically
 * impossible here: a shop's net contribution deliberately EXCLUDES losses (a
 * branch is not blamed for stock that never sold), while the business's net
 * income must include them (a stolen engine is real money gone). The two sides
 * differ by exactly the shrinkage, so the identity carries it explicitly.
 *
 * Both rules survive, and neither page lies:
 *   • per shop  — contribution, losses shown alongside as context
 *   • business  — net income, shrinkage subtracted where it actually lands
 *
 * It holds by construction, not by coincidence:
 *   shopNetTotal = Σ(gross_profit − shop opex)
 *                = grossProfit − shopOpex
 *   netIncome    = grossProfit − shrinkage − shopOpex − companyOverhead
 *                = shopNetTotal − companyOverhead − shrinkage   ∎
 *
 * ---------------------------------------------------------------------------
 * THE RULES, AND WHY
 *
 *  • Revenue is APPROVED sales only. recorded/pending/questioned/rejected are
 *    not revenue — the owner hasn't agreed they happened.
 *  • Revenue is ACCRUAL. It includes utang not yet collected. Net income is
 *    what was EARNED; see `collected` for what actually arrived. Never present
 *    one as the other.
 *  • COGS is read from `sale_line_costs`, frozen at approval (0038) — never
 *    from `parts.cost_centavos`, which is mutable and would let one cost edit
 *    silently rewrite last month's profit.
 *  • Losses are valued at COST, never selling price. `losses.value_centavos` is
 *    stamped at approval from cost. Valuing a damaged engine at what it might
 *    have fetched invents a loss that never happened.
 *  • Returns are NOT a loss. Stock moved back; nothing was destroyed. The
 *    three-way separation (transit write-off · shop loss · return) survives.
 *  • Labor is NOT a line here. Payroll was removed from the app; wages, if the
 *    owner records them, ride the Expenses module (shop opex / company overhead)
 *    like any other operating cost.
 *  • Company overhead is NEVER allocated across shops. It is subtracted once,
 *    at the bottom. Honest beats clever.
 *  • Closed shops still count. A branch that shut mid-period still sold and
 *    still cost money in that period.
 */

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
  /**
   * Approved engine lines with no asking/agreed recorded — sales from before
   * tier pricing existed (0020). Reported, never counted as a zero discount:
   * "we don't know" and "nothing was discounted" are different claims.
   */
  engineDiscountUnknownLines: number;
}

const pct = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;

/**
 * Refuse to compute a P&L for anyone but the owner.
 *
 * RLS already stops a shop reading costs and expenses — but that is precisely
 * the danger. Run on an employee's session the queries all SUCCEED and simply
 * return less: COGS 0, opex 0, while `sales` stays
 * readable because a shop must see its own sales to submit them. The arithmetic
 * then happily reports gross profit = revenue and a net income that is just
 * revenue wearing a hat — a confidently wrong number, which is worse than an
 * error.
 *
 * A partial view is not a safe view. Fail loudly instead.
 */
async function requireOwner(supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase.rpc("is_owner");
  if (error) throw new Error(`Could not verify the caller: ${error.message}`);
  if (!data) throw new Error("Only the owner can compute the P&L");
}

/**
 * Fetch EVERY row of a query, 1,000 at a time.
 *
 * PostgREST silently caps an un-ranged select at the API's max-rows (1,000).
 * At demo scale that was invisible; the 300k-row load test showed the P&L
 * quietly computing from the first 1,000 of ~29,000 sales — a confidently
 * wrong number, the exact thing this module refuses to be. The builder is a
 * FACTORY because a supabase query is consumed on await; each page needs a
 * fresh one. A page error throws — partial money math is not money math.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function fetchAll<T = any>(
  build: () => any,
  key = "id"
): Promise<T[]> {
  // KEYSET pagination, not offset: `.range(25000, …)` makes Postgres walk and
  // discard 25k rows per page, which blows the free tier's statement timeout
  // on deep pages. A `> cursor` on the PK is an index seek — every page costs
  // the same. The builder must NOT set its own order/limit; this owns both.
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
      throw new Error(`P&L query failed: ${error.message}`);
    }
    out.push(...page);
    if (page.length < 1000) return out;
    cursor = (page[page.length - 1] as any)[key];
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Did this shop earn or cost anything in the period?
 *
 * The money-only test. An OPEN shop always deserves a row even at zero — it's
 * a branch that exists. A CLOSED one only earns a row if something actually
 * happened, so a branch that shut two years ago doesn't pad every report
 * forever. Callers with extra context (stock on hand, deliveries, pending
 * approvals) should OR this with their own.
 */
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

/**
 * Compute the P&L for a PH business-date range.
 *
 * `shopId` filters to one branch — used by /shops/reports' shop picker. The
 * consolidated P&L never passes it: company overhead belongs to no shop, so a
 * filtered "net income" would be a category error.
 */
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

/**
 * The original O(transactions) implementation — fetch every sale/line/cost in
 * the range and sum in JS. Kept as the fallback (works before 0075 is applied)
 * and as the reference the SQL path is proven byte-identical against.
 */
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
          .gte("created_at", from)
          .lte("created_at", `${to}T23:59:59.999`)
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

/**
 * Gather P&L facts: SQL fast path (fn_pnl_facts, 0075) → flat O(shops×days);
 * falls back to the row-walk if the migration isn't applied. Both paths are
 * asserted byte-identical (scripts/test-pnl + the capture check).
 */
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
// ---------------------------------------------------------------------------
// Cash vs accrual
//
// Net income is EARNED. This is what actually arrived. They are different
// numbers and the UI must never let one stand in for the other: a month can
// earn ₱200k and collect ₱40k, and paying suppliers out of the ₱200k is how a
// profitable business runs out of money.
// ---------------------------------------------------------------------------
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
  // Same reasoning as computePnl: a shop can read its own sales and its own
  // receivables, so this would return a real-looking cash position covering one
  // branch and call it the business's.
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

    // `business_date` — utang_payments has no paid_on. And voided payments are
    // soft-deleted, so they drop out here on their own: the balance they gave
    // back is real, and so is their absence from cash in.
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

  // Cash taken at the till.
  //
  // NOT simply Σ amount_paid_centavos: that column arrived with partial payments
  // (0020) and is NULL on every full-payment sale recorded before it, so summing
  // it books a fully-paid ₱75,360 sale as ₱0 collected and quietly breaks
  // `collected + outstanding = earned`. A 'full' sale is paid in full by
  // definition — its total IS the cash. The column only ever means anything on a
  // partial sale, where it is the downpayment.
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
