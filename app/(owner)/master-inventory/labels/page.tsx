import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { LabelPrinter } from "./label-printer";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export const metadata: Metadata = { title: "Print Labels" };

/**
 * The tab bar (in the layout) stays instant; only the picker + preview stream
 * in behind a matching skeleton — consistent with the Products tab.
 */
export default function LabelsPage({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string }>;
}) {
  return (
    <Suspense fallback={<LabelsSkeleton />}>
      <LabelsBody searchParams={searchParams} />
    </Suspense>
  );
}

async function LabelsBody({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string }>;
}) {
  const { ids } = await searchParams;
  const supabase = await createClient();

  const { data } = await supabase
    .from("parts")
    .select("id, name, barcode, price_centavos")
    .is("deleted_at", null)
    .not("barcode", "is", null)
    .order("name");

  const preselected = (ids ?? "").split(",").filter(Boolean);

  return <LabelPrinter parts={data ?? []} preselected={preselected} />;
}

function LabelsSkeleton() {
  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-24" />
          <Skeleton className="mt-2 h-3 w-64" />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Skeleton className="h-9 w-full" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-9 w-28" />
            <Skeleton className="h-9 w-28" />
          </div>
          <div className="flex flex-col gap-2 rounded-md border p-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2">
                <Skeleton className="h-4 w-4" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-8 w-16" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-36" />
          <Skeleton className="mt-2 h-3 w-48" />
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-md" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
