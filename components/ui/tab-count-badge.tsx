import { Badge } from "@/components/ui/badge";

/** Same pill as the sidebar nav badges, so tab counts read consistently. Hidden
 *  at 0; inverts on the active tab's fill via `data-state=active`. */
export function TabCountBadge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <Badge className="ml-1.5 h-5 min-w-5 justify-center px-1 tabular-nums [[data-state=active]_&]:border-transparent [[data-state=active]_&]:bg-primary-foreground [[data-state=active]_&]:text-primary">
      {count}
    </Badge>
  );
}
