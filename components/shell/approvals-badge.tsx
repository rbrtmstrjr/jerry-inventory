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

  // Per-INSTANCE topic — the nav renders twice on mobile (hidden desktop aside
  // + burger sheet), and reusing a subscribed channel's topic throws when the
  // second mount adds its postgres_changes callbacks. Same fix as nav-badges.
  const instanceId = React.useId();

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
      .channel(`approvals-badge-${instanceId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "sales" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "losses" }, load)
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
    // instanceId is stable for the life of the component → intentionally stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
