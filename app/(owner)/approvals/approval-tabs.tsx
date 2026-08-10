"use client";

import Link from "next/link";

import { cn } from "@/lib/utils";
import { TabCountBadge } from "@/components/ui/tab-count-badge";

export type QueueTab = "all" | "sales" | "losses" | "expenses";

const TABS: { value: QueueTab; label: string }[] = [
  { value: "all", label: "All" },
  { value: "sales", label: "Sales" },
  { value: "losses", label: "Losses" },
  { value: "expenses", label: "Expenses" },
];

/** Links, not client state, so switching renders only that tab's data. `counts`
 *  is optional: the bar paints without it and the badges stream in after. */
export function ApprovalTabs({
  active,
  counts,
}: {
  active: QueueTab;
  counts?: Record<QueueTab, number>;
}) {
  return (
    <nav
      aria-label="Approval queue"
      className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 shadow-[inset_0_-1px_0_var(--border)]"
    >
      {TABS.map((t) => (
        <Link
          key={t.value}
          href={`/approvals?tab=${t.value}`}
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
