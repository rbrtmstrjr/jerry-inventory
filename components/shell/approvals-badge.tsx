"use client";

import * as React from "react";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";

/** Live count of submissions awaiting the owner (sales + losses). */
export function ApprovalsBadge() {
  const [count, setCount] = React.useState<number | null>(null);

  React.useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    async function load() {
      const [s, l] = await Promise.all([
        supabase
          .from("sales")
          .select("id", { count: "exact", head: true })
          .in("status", ["pending", "questioned"])
          .is("deleted_at", null),
        supabase
          .from("losses")
          .select("id", { count: "exact", head: true })
          .in("status", ["pending", "questioned"])
          .is("deleted_at", null),
      ]);
      if (!cancelled) setCount((s.count ?? 0) + (l.count ?? 0));
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
    <Badge className="ml-auto h-5 min-w-5 justify-center px-1.5 tabular-nums">
      {count}
    </Badge>
  );
}
