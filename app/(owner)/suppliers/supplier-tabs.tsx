"use client";

import Link from "next/link";

import { cn } from "@/lib/utils";

// Order tells the story: order it · receive it · owe it · compare it.
const TABS = [
  { value: "directory", label: "Directory" },
  { value: "receiving", label: "Receiving" },
  { value: "payables", label: "Payables" },
  { value: "comparison", label: "Price Comparison" },
] as const;

/** `?tab=` links, same shape as /reports and /movements. */
export function SupplierTabs({
  active,
}: {
  active: "directory" | "receiving" | "payables" | "comparison";
}) {
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
