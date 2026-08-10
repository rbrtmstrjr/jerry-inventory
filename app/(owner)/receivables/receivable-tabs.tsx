"use client";

import Link from "next/link";

import { cn } from "@/lib/utils";
import { TabCountBadge } from "@/components/ui/tab-count-badge";

export type ReceivableTab = "open" | "paid";

const TABS: { value: ReceivableTab; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "paid", label: "Fully paid" },
];

/** Links, not client state — each tab is a different server query. `counts` is
 *  optional so the bar can render instantly as a Suspense fallback. */
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
