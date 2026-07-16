"use client";

import Link from "next/link";

import { cn } from "@/lib/utils";

const TABS = [
  { value: "journal", label: "Journal" },
  { value: "ledger", label: "Stock Card" },
  { value: "engines", label: "Engine History" },
] as const;

/**
 * `?tab=` links, matching /deliveries and /reports.
 *
 * Each tab is a different server query — the journal paginates the whole
 * ledger, the stock card runs a window function for one product — so they are
 * links, not client state: switching must not fetch all three.
 *
 * Filters are deliberately DROPPED when switching tabs. A journal filter
 * (location, type, actor) means nothing to a stock card, and carrying `?type=`
 * across would silently narrow a card the user thinks is complete.
 */
export function MovementTabs({ active }: { active: "journal" | "ledger" | "engines" }) {
  return (
    <nav
      aria-label="Movements"
      className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 shadow-[inset_0_-1px_0_var(--border)]"
    >
      {TABS.map((t) => (
        <Link
          key={t.value}
          href={`/movements?tab=${t.value}`}
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
