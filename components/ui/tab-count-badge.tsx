import { Badge } from "@/components/ui/badge";

/**
 * Count badge for a tab trigger — the same pill the sidebar nav badges use, so
 * tab counts read consistently across the app instead of a "(3)" in parens.
 * Hidden at 0. Inverts to a light pill when its tab is active (via the
 * `data-state=active` the Tabs trigger sets on itself) so it stays readable on
 * the active fill.
 */
export function TabCountBadge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <Badge className="ml-1.5 h-5 min-w-5 justify-center px-1 tabular-nums [[data-state=active]_&]:border-transparent [[data-state=active]_&]:bg-primary-foreground [[data-state=active]_&]:text-primary">
      {count}
    </Badge>
  );
}
