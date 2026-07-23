"use client";

import * as React from "react";
import { createClient } from "@/lib/supabase/client";
import { getOwnerCounts } from "@/components/shell/badge-counts";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Live count of submissions awaiting the owner (sales + losses). */
export function ApprovalsBadge({
  active,
  initialCount,
}: {
  active?: boolean;
  initialCount?: number;
}) {
  const [count, setCount] = React.useState<number | null>(initialCount ?? null);

  React.useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    async function load() {
      // batched with the other owner badges — one round-trip for all six
      try {
        const { approvals } = await getOwnerCounts(supabase);
        if (!cancelled) setCount(approvals);
      } catch {
        /* transient — keep the last known count */
      }
    }

    load();
    const channel = supabase
      .channel("approvals-badge")
      .on("postgres_changes", { event: "*", schema: "public", table: "sales" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "losses" }, load)
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

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
