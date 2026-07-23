import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * All six owner sidebar counts in ONE round-trip (fn_nav_badge_counts, 0074).
 *
 * The badges used to fire ~9 separate count queries — each its own round-trip,
 * trickling in over slow shop wifi. This batches them: every badge's loader
 * calls getOwnerCounts(), which is memoised for a short window so the mount
 * burst (6 badges at once) and each realtime-triggered refresh collapse into a
 * single RPC. Falls back to the individual count queries if 0074 isn't applied,
 * so behaviour degrades gracefully — never worse than before.
 *
 * Non-blocking: this runs client-side, so the shell still paints instantly; the
 * counts just arrive together a moment later instead of one at a time.
 */

export interface OwnerCounts {
  approvals: number;
  deliveries: number;
  stock_alerts: number;
  receivables: number;
  warranties: number;
  suppliers: number;
}

let cached: Promise<OwnerCounts> | null = null;
let cachedAt = 0;
const TTL_MS = 800; // long enough to dedupe a mount / realtime burst, short enough to stay fresh

export function getOwnerCounts(sb: SupabaseClient): Promise<OwnerCounts> {
  const now = Date.now();
  if (!cached || now - cachedAt > TTL_MS) {
    cachedAt = now;
    cached = fetchOwnerCounts(sb).catch((e) => {
      cached = null; // let the next caller retry rather than cache a failure
      throw e;
    });
  }
  return cached;
}

async function fetchOwnerCounts(sb: SupabaseClient): Promise<OwnerCounts> {
  // fast path — one SQL round-trip
  const { data, error } = await sb.rpc("fn_nav_badge_counts");
  if (!error && data) {
    const d = data as Record<string, number>;
    return {
      approvals: d.approvals ?? 0,
      deliveries: d.deliveries ?? 0,
      stock_alerts: d.stock_alerts ?? 0,
      receivables: d.receivables ?? 0,
      warranties: d.warranties ?? 0,
      suppliers: d.suppliers ?? 0,
    };
  }
  // fallback — the individual counts (pre-0074), still one deduped batch
  const [appr, del, ret, mLow, sLow, req, recv, warr, sup] = await Promise.all([
    sb.from("sales").select("id", { count: "exact", head: true }).in("status", ["pending", "questioned"]).is("deleted_at", null),
    sb.from("deliveries").select("id", { count: "exact", head: true }).in("status", ["requested", "discrepancy"]).is("deleted_at", null),
    sb.from("returns").select("id", { count: "exact", head: true }).eq("status", "requested").is("deleted_at", null),
    sb.from("master_low_stock").select("*", { count: "exact", head: true }),
    sb.from("shop_low_stock").select("*", { count: "exact", head: true }),
    sb.from("delivery_requests").select("id", { count: "exact", head: true }).eq("status", "open").is("deleted_at", null),
    sb.from("receivables").select("*", { count: "exact", head: true }).gt("balance_centavos", 0),
    sb.from("warranty_claims").select("id", { count: "exact", head: true }).eq("status", "requested").is("deleted_at", null),
    sb.from("receiving_balances").select("*", { count: "exact", head: true }).eq("overdue", true),
  ]);
  return {
    approvals: appr.count ?? 0,
    deliveries: (del.count ?? 0) + (ret.count ?? 0),
    stock_alerts: (mLow.count ?? 0) + (sLow.count ?? 0) + (req.count ?? 0),
    receivables: recv.count ?? 0,
    warranties: warr.count ?? 0,
    suppliers: sup.count ?? 0,
  };
}
