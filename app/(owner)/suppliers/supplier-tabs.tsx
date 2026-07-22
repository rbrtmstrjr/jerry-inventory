"use client";

import * as React from "react";
import Link from "next/link";

import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// Order tells the story: order it · receive it · owe it · compare it.
const TABS = [
  { value: "directory", label: "Directory" },
  { value: "receiving", label: "Receiving" },
  { value: "payables", label: "Payables" },
  { value: "comparison", label: "Price Comparison" },
] as const;

/**
 * Overdue supplier debt — the same count the sidebar Suppliers badge shows, but
 * surfaced on the Payables tab where the action actually lives. One-shot fetch
 * on mount + a focus refresh (overdue is a date-based state; recording a payment
 * revalidates the page, which remounts this and refetches).
 */
function useOverdueCount() {
  const [count, setCount] = React.useState<number | null>(null);
  React.useEffect(() => {
    const sb = createClient();
    let cancelled = false;
    const run = async () => {
      try {
        const { count: n } = await sb
          .from("receiving_balances")
          .select("*", { count: "exact", head: true })
          .eq("overdue", true);
        if (!cancelled) setCount(n ?? 0);
      } catch {
        /* transient — keep last known */
      }
    };
    run();
    window.addEventListener("focus", run);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", run);
    };
  }, []);
  return count;
}

/** `?tab=` links, same shape as /reports and /movements. */
export function SupplierTabs({
  active,
}: {
  active: "directory" | "receiving" | "payables" | "comparison";
}) {
  const overdue = useOverdueCount();

  return (
    <nav
      aria-label="Suppliers"
      className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 shadow-[inset_0_-1px_0_var(--border)]"
    >
      {TABS.map((t) => (
        <Link
          key={t.value}
          href={`/suppliers?tab=${t.value}`}
          aria-current={active === t.value ? "page" : undefined}
          className={cn(
            "inline-flex shrink-0 items-center gap-2 rounded-t-md border-b-2 px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
            active === t.value
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          )}
        >
          {t.label}
          {t.value === "payables" && !!overdue && (
            <Badge
              className="h-5 min-w-5 justify-center border-transparent bg-[var(--aging-high)] px-1.5 tabular-nums text-white shadow-sm hover:bg-[var(--aging-high)]"
              aria-label={`${overdue} overdue`}
            >
              {overdue}
            </Badge>
          )}
        </Link>
      ))}
    </nav>
  );
}
