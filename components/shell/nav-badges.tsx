"use client";

import * as React from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { getOwnerCounts } from "@/components/shell/badge-counts";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Sidebar count badges (owner nav) — the same "needs your attention" hint the
 * Approval Queue has, extended to the other action pages.
 *
 * Each badge loads a count, then keeps it fresh two ways: a realtime
 * subscription on the tables that feed it (for tables in the realtime
 * publication — sales, losses, deliveries, delivery_requests, utang_payments,
 * notifications) and a reload whenever the tab regains focus (the safety net
 * for counts that derive from tables NOT in the publication, e.g. stock levels).
 *
 * All are owner-only surfaces; RLS on the owner's session returns every shop.
 */

type Loader = (sb: SupabaseClient) => Promise<number>;

function useNavCount(
  load: Loader,
  tables: readonly string[],
  initialCount?: number
) {
  // Seed from the server-computed count so the badge is correct in the FIRST
  // paint (no slow pop-in), then keep it live via realtime + focus refresh.
  const [count, setCount] = React.useState<number | null>(initialCount ?? null);

  React.useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    const run = async () => {
      try {
        const n = await load(supabase);
        if (!cancelled) setCount(n);
      } catch {
        /* transient network/RLS error — keep the last known count */
      }
    };

    run();

    const channel = supabase.channel(`nav-badge-${tables.join("_")}`);
    for (const t of tables) {
      channel.on("postgres_changes", { event: "*", schema: "public", table: t }, run);
    }
    channel.subscribe();

    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    window.addEventListener("focus", run);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
      window.removeEventListener("focus", run);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // load + tables are module-scope constants per badge → intentionally stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return count;
}

// When the row is active the nav button is `bg-sidebar-primary`, so the default
// primary badge would be blue-on-blue and vanish — invert it to a light pill.
function CountBadge({ count, active }: { count: number | null; active?: boolean }) {
  if (!count) return null;
  return (
    <Badge
      className={cn(
        "ml-auto h-5 min-w-5 justify-center px-1.5 tabular-nums",
        active && "border-transparent bg-sidebar-primary-foreground text-sidebar-primary"
      )}
    >
      {count}
    </Badge>
  );
}

// ── Deliveries & Returns ────────────────────────────────────────────────────
// What the OWNER must act on HERE: transit discrepancies to resolve + shop-to-
// shop transfers awaiting approval. Shop stock-requests moved to Stock Alerts.
// Regular in-transit deliveries wait on the SHOP to confirm, so they don't
// count; `status in ('requested','discrepancy')` catches transfer requests +
// every discrepancy (delivery or transfer), never plain in-transit.
const DELIVERIES_TABLES = ["deliveries", "returns"] as const;
async function loadDeliveries(sb: SupabaseClient) {
  return (await getOwnerCounts(sb)).deliveries;
}
export function DeliveriesBadge({ active, initialCount }: { active?: boolean; initialCount?: number }) {
  return <CountBadge count={useNavCount(loadDeliveries, DELIVERIES_TABLES, initialCount)} active={active} />;
}

// ── Stock Alerts ────────────────────────────────────────────────────────────
// Every item at/below its reorder threshold — master (buy) + all shops
// (deliver) — PLUS open shop stock-requests (moved here from Deliveries). Low-
// stock derives from stock levels (not realtime), so this rides notifications +
// focus refresh; delivery_requests IS realtime, so new requests bump it live.
const STOCK_TABLES = ["notifications", "delivery_requests"] as const;
async function loadStockAlerts(sb: SupabaseClient) {
  return (await getOwnerCounts(sb)).stock_alerts;
}
export function StockAlertsBadge({ active, initialCount }: { active?: boolean; initialCount?: number }) {
  return <CountBadge count={useNavCount(loadStockAlerts, STOCK_TABLES, initialCount)} active={active} />;
}

// ── Receivables ─────────────────────────────────────────────────────────────
// Sales that still carry an outstanding balance (customer owes). The view keeps
// settled rows for history, so filter to a live balance.
const RECEIVABLES_TABLES = ["sales", "utang_payments"] as const;
async function loadReceivables(sb: SupabaseClient) {
  return (await getOwnerCounts(sb)).receivables;
}
export function ReceivablesBadge({ active, initialCount }: { active?: boolean; initialCount?: number }) {
  return <CountBadge count={useNavCount(loadReceivables, RECEIVABLES_TABLES, initialCount)} active={active} />;
}

// ── Warranties & Serials ────────────────────────────────────────────────────
// Warranty claims a shop filed and is waiting on — the one thing the owner acts
// on here (approve/reject). Clears as each is decided.
const WARRANTIES_TABLES = ["warranty_claims"] as const;
async function loadWarrantyClaimsPending(sb: SupabaseClient) {
  return (await getOwnerCounts(sb)).warranties;
}
export function WarrantiesBadge({ active, initialCount }: { active?: boolean; initialCount?: number }) {
  return <CountBadge count={useNavCount(loadWarrantyClaimsPending, WARRANTIES_TABLES, initialCount)} active={active} />;
}

// ── Suppliers (Payables) ────────────────────────────────────────────────────
// What the OWNER must act on: supplier debt that is PAST its due date. Counts
// overdue receivings (open balance, due date passed) — the same red rows the
// Payables tab highlights. "Overdue" is a date-based state that no table event
// fires for, so this leans on the focus/visibility refresh plus the daily
// overdue cron (which raises a notification → realtime bump).
const SUPPLIERS_TABLES = ["receivings", "supplier_payments", "notifications"] as const;
async function loadOverduePayables(sb: SupabaseClient) {
  return (await getOwnerCounts(sb)).suppliers;
}
export function SuppliersBadge({ active, initialCount }: { active?: boolean; initialCount?: number }) {
  return <CountBadge count={useNavCount(loadOverduePayables, SUPPLIERS_TABLES, initialCount)} active={active} />;
}

// ── Birthdays (Dashboard) ───────────────────────────────────────────────────
// Staff whose birthday is TODAY (PH month-day, from staff_birthdays_today / 0079)
// — the celebrant card lives on the Dashboard. Date-based, so no table event
// fires: it rides the focus/visibility refresh (plus a staff edit if `staff` is
// in the realtime publication). Missing view (migration not applied) → the count
// query errors → useNavCount keeps null → no badge, so it degrades gracefully.
const BIRTHDAY_TABLES = ["staff"] as const;
async function loadBirthdays(sb: SupabaseClient) {
  const { count } = await sb
    .from("staff_birthdays_today")
    .select("id", { count: "exact", head: true });
  return count ?? 0;
}
export function BirthdayBadge({ active, initialCount }: { active?: boolean; initialCount?: number }) {
  return <CountBadge count={useNavCount(loadBirthdays, BIRTHDAY_TABLES, initialCount)} active={active} />;
}

// ────────────────────────────────────────────────────────────────────────────
// Shop (employee) badges. The safe views are already RLS-scoped to the caller's
// own shop, so a plain count is shop-specific. These render only in an employee
// session (attached to the employee nav), never for the owner.
// ────────────────────────────────────────────────────────────────────────────

// Incoming Deliveries — stock on the way this shop must COUNT + CONFIRM. Matches
// the "To confirm" tab exactly: in-transit deliveries not yet confirmed.
const SHOP_DELIVERIES_TABLES = ["deliveries"] as const;
async function loadShopIncoming(sb: SupabaseClient) {
  const { count } = await sb
    .from("shop_incoming_deliveries")
    .select("*", { count: "exact", head: true })
    .eq("status", "in_transit");
  return count ?? 0;
}
export function ShopDeliveriesBadge({ active, initialCount }: { active?: boolean; initialCount?: number }) {
  return <CountBadge count={useNavCount(loadShopIncoming, SHOP_DELIVERIES_TABLES, initialCount)} active={active} />;
}

// Low Stock — this shop's items at/below their effective reorder threshold.
// Derives from stock levels (not in the realtime publication), so it rides the
// notification bumps + the focus/visibility refresh.
const SHOP_LOW_TABLES = ["notifications"] as const;
async function loadShopLowStock(sb: SupabaseClient) {
  const { count } = await sb
    .from("shop_low_stock_safe")
    .select("*", { count: "exact", head: true });
  return count ?? 0;
}
export function ShopLowStockBadge({ active, initialCount }: { active?: boolean; initialCount?: number }) {
  return <CountBadge count={useNavCount(loadShopLowStock, SHOP_LOW_TABLES, initialCount)} active={active} />;
}

// Receivables — this shop's customers with an outstanding utang balance.
const SHOP_RECEIVABLES_TABLES = ["sales", "utang_payments"] as const;
async function loadShopReceivables(sb: SupabaseClient) {
  const { count } = await sb
    .from("shop_receivables")
    .select("*", { count: "exact", head: true })
    .gt("balance_centavos", 0);
  return count ?? 0;
}
export function ShopReceivablesBadge({ active, initialCount }: { active?: boolean; initialCount?: number }) {
  return <CountBadge count={useNavCount(loadShopReceivables, SHOP_RECEIVABLES_TABLES, initialCount)} active={active} />;
}
