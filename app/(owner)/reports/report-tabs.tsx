"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { cn } from "@/lib/utils";

const TABS = [
  { value: "sales", label: "Sales & Inventory" },
  { value: "pnl", label: "P&L / Net Income" },
  { value: "shops", label: "Per-Shop Profitability" },
] as const;

/** Links, not client state — each tab is a different server fetch. The date
 *  range rides along so switching keeps the period you were looking at. */
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
