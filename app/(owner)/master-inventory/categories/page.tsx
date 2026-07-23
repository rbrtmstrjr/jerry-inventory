import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { CategoriesView } from "./categories-view";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export const metadata: Metadata = { title: "Categories" };

/**
 * The tab bar (in the layout) stays instant; only the categories card streams
 * in behind a matching skeleton — consistent with the Products tab.
 */
export default function CategoriesPage() {
  return (
    <Suspense fallback={<CategoriesSkeleton />}>
      <CategoriesBody />
    </Suspense>
  );
}

async function CategoriesBody() {
  const supabase = await createClient();

  const [catsRes, partsRes] = await Promise.all([
    supabase
      .from("product_categories")
      .select("id, name")
      .is("deleted_at", null)
      .order("name"),
    // usage = how many LIVE parts reference each category
    supabase.from("parts").select("category_id").is("deleted_at", null),
  ]);

  const usage: Record<string, number> = {};
  for (const p of partsRes.data ?? []) {
    if (p.category_id) usage[p.category_id] = (usage[p.category_id] ?? 0) + 1;
  }

  const categories = (catsRes.data ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    usage: usage[c.id] ?? 0,
  }));

  return <CategoriesView categories={categories} />;
}

function CategoriesSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="mt-2 h-3 w-72" />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-end gap-2">
          <Skeleton className="h-9 flex-1" />
          <Skeleton className="h-9 w-28" />
        </div>
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-2 rounded-md border px-3 py-2"
            >
              <Skeleton className="h-8 min-w-40 flex-1" />
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-8 w-8" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
