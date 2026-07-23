import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/**
 * Shared loading skeletons for streaming page shells. Kept generic so the
 * many owner list/report pages that stream their body behind `<Suspense>` can
 * share one matching placeholder instead of each hand-rolling its own.
 */

/** Toolbar (search + action) over a bordered table — matches a `<DataTable>`. */
export function TableSkeleton({
  cols = 5,
  rows = 8,
  toolbar = true,
}: {
  cols?: number;
  rows?: number;
  toolbar?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      {toolbar && (
        <div className="flex items-center justify-between">
          <Skeleton className="h-9 w-full max-w-xs" />
          <Skeleton className="h-9 w-32" />
        </div>
      )}
      <div className="overflow-hidden rounded-md border">
        <div className="flex gap-4 border-b bg-muted/30 px-4 py-3">
          {Array.from({ length: cols }).map((_, i) => (
            <Skeleton key={i} className="h-4 flex-1" />
          ))}
        </div>
        {Array.from({ length: rows }).map((_, r) => (
          <div
            key={r}
            className="flex items-center gap-4 border-b px-4 py-3.5 last:border-0"
          >
            {Array.from({ length: cols }).map((_, i) => (
              <Skeleton key={i} className="h-4 flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Filter bar + stat tiles + chart cards — matches a reports dashboard. */
export function ReportSkeleton({
  tiles = 4,
  charts = 2,
}: {
  tiles?: number;
  charts?: number;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-9 w-36" />
          <Skeleton className="h-9 w-36" />
          <Skeleton className="h-9 w-40" />
        </div>
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: tiles }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="pb-2">
              <Skeleton className="h-3 w-24" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-7 w-28" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: charts }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-4 w-40" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-56 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
