"use client";

import Link from "next/link";

import { cn } from "@/lib/utils";

export type QueueTab = "all" | "sales" | "losses" | "expenses";

const TABS: { value: QueueTab; label: string }[] = [
  { value: "all", label: "All" },
  { value: "sales", label: "Sales" },
  { value: "losses", label: "Losses" },
  { value: "expenses", label: "Expenses" },
];

/**
 * `?tab=` links, matching /movements and /reports. Each tab is a DIFFERENT
 * server query — the type tabs fetch only their own rows, "All" builds the
 * per-shop batches from every type — so they are links, not client state:
 * switching a tab renders only that tab's data, never all of them at once.
 *
 * No counts here on purpose: a count needs a DB read, and doing that read in the
 * page shell would suspend it on I/O and fall back to the whole-segment loader
 * (heading + tabs included). Labels only keeps the shell instant.
 */
export function ApprovalTabs({ active }: { active: QueueTab }) {
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
        </Link>
      ))}
    </nav>
  );
}
