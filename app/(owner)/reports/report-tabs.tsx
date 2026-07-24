"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { cn } from "@/lib/utils";

const TABS = [
  { value: "sales", label: "Sales & Inventory" },
  { value: "pnl", label: "P&L / Net Income" },
  { value: "shops", label: "Per-Shop Profitability" },
] as const;

/**
 * Link-based tabs over `?tab=`, the same shape /deliveries uses.
 *
 * Links rather than client state, because each tab is a genuinely different
 * server fetch: the P&L pulls costs and overhead the sales report has no use
 * for. Holding both in one client view would fetch both every time and make the
 * range un-bookmarkable.
 *
 * The date range rides along, so flipping to the P&L keeps the period you were
 * already looking at instead of silently resetting it.
 */
export function ReportTabs({ active }: { active: "sales" | "pnl" | "shops" }) {
  const params = useSearchParams();

  function hrefFor(tab: string) {
    const next = new URLSearchParams(params.toString());
    next.set("tab", tab);
    return `/reports?${next.toString()}`;
  }

  return (
    <nav
      aria-label="Report"
      className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 shadow-[inset_0_-1px_0_var(--border)]"
    >
      {TABS.map((t) => (
        <Link
          key={t.value}
          href={hrefFor(t.value)}
          aria-current={active === t.value ? "page" : undefined}
          className={cn(
            "shrink-0 rounded-t-md border-b-2 px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
            active === t.value
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
