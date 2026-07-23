"use client";

import Link from "next/link";

import { cn } from "@/lib/utils";
import { TabCountBadge } from "@/components/ui/tab-count-badge";

export type ReceivableTab = "open" | "paid";

const TABS: { value: ReceivableTab; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "paid", label: "Fully paid" },
];

/**
 * `?tab=` links (Open / Fully paid), matching /approvals and /movements. Each
 * tab is a DIFFERENT server query — Open pulls balance > 0, Fully paid pulls
 * balance ≤ 0 — so they are links, not client state: the parent never fetches
 * both sets for the client to split.
 *
 * `counts` is OPTIONAL so the bar renders instantly (labels) as a Suspense
 * fallback while the head-count query streams the badges in — the shell never
 * suspends on I/O (which would fall back to the whole-segment loader).
 */
export function ReceivableTabs({
  active,
  counts,
}: {
  active: ReceivableTab;
  counts?: Record<ReceivableTab, number>;
}) {
  return (
    <nav
      aria-label="Receivables"
      className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 shadow-[inset_0_-1px_0_var(--border)]"
    >
      {TABS.map((t) => (
        <Link
          key={t.value}
          href={`/receivables?tab=${t.value}`}
          aria-current={active === t.value ? "page" : undefined}
          className={cn(
            "flex shrink-0 items-center rounded-t-md border-b-2 px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
            active === t.value
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          )}
        >
          {t.label}
          {counts && <TabCountBadge count={counts[t.value]} />}
        </Link>
      ))}
    </nav>
  );
}
