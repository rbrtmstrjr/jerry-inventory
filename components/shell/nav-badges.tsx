"use client";

import * as React from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { getOwnerCounts } from "@/components/shell/badge-counts";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Sidebar "needs your attention" counts. Each stays fresh via a realtime
 *  subscription plus a refresh on tab focus (for non-realtime feeder tables). */

type Loader = (sb: SupabaseClient) => Promise<number>;

function useNavCount(
  load: Loader,
  tables: readonly string[],
  initialCount?: number
) {
  // Seed from the server-computed count so the badge is correct in the FIRST
  // paint (no slow pop-in), then keep it live via realtime + focus refresh.
  const [count, setCount] = React.useState<number | null>(initialCount ?? null);

  // Per-INSTANCE topic: the nav mounts twice on mobile, and re-subscribing a
  // shared channel throws. useId is unique per component instance.
  const instanceId = React.useId();

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

    const channel = supabase.channel(`nav-badge-${tables.join("_")}-${instanceId}`);
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
    // load + tables are module-scope constants per badge, instanceId is stable
    // for the life of the component → intentionally stable.
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
// Discrepancies to resolve + transfers awaiting approval. Plain in-transit
// waits on the SHOP to confirm, so it is excluded.
const DELIVERIES_TABLES = ["deliveries", "returns"] as const;
async function loadDeliveries(sb: SupabaseClient) {
  return (await getOwnerCounts(sb)).deliveries;
}
export function DeliveriesBadge({ active, initialCount }: { active?: boolean; initialCount?: number }) {
  return <CountBadge count={useNavCount(loadDeliveries, DELIVERIES_TABLES, initialCount)} active={active} />;
}

// ── Stock Alerts ────────────────────────────────────────────────────────────
// Every low item (master + all shops) plus open shop stock-requests. Low stock
// isn't realtime, so it rides notifications + the focus refresh.
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
// Overdue supplier debt only — a badge lit by any credit purchase is noise.
// Date-based, so it leans on the focus refresh + the daily overdue cron.
const SUPPLIERS_TABLES = ["receivings", "supplier_payments", "notifications"] as const;
async function loadOverduePayables(sb: SupabaseClient) {
  return (await getOwnerCounts(sb)).suppliers;
}
export function SuppliersBadge({ active, initialCount }: { active?: boolean; initialCount?: number }) {
  return <CountBadge count={useNavCount(loadOverduePayables, SUPPLIERS_TABLES, initialCount)} active={active} />;
}

// ── Birthdays (Dashboard) ───────────────────────────────────────────────────
// Staff whose birthday is today (PH month-day). Date-based, so it rides the
// focus refresh; a missing view leaves the count null and shows no badge.
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

// ── Shop (employee) badges ──────────────────────────────────────────────────
// The safe views are RLS-scoped, so a plain count is already shop-specific.

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

// Low Stock — this shop's items at/below their effective threshold. Not
// realtime, so it rides notification bumps + the focus refresh.
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
