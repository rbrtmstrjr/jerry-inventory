import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/pnl";
import { TableSkeleton } from "@/components/shell/streaming-skeletons";
import {
  ExpenseCategoriesView,
  type CategoryRow,
  type ProposedCategoryRow,
} from "./categories-view";

export const metadata: Metadata = { title: "Expense Categories" };

/** Shell: the layout's heading + tabs stay instant; the category table streams. */
export default function ExpenseCategoriesPage() {
  return (
    <Suspense fallback={<TableSkeleton cols={4} />}>
      <ExpenseCategoriesBody />
    </Suspense>
  );
}

async function ExpenseCategoriesBody() {
  const supabase = await createClient();

  const [categoriesRes, allExpenses] = await Promise.all([
    supabase
      .from("expense_categories")
      .select("id, name, sort_order, active, status, shops(name, color_key)")
      .is("deleted_at", null)
      .order("sort_order"),
    // PAGED. An unpaged select stops at PostgREST's 1,000-row cap, and staging
    // already holds 13k expenses — so every usage count here was computed from
    // ~8% of the data. Effects: a proposal's "N expenses" caption read 0, the
    // Merge dialog promised to move "0 expenses" while moving one, and a
    // category that IS in use got the "It can no longer be picked; history
    // stays intact." copy meant for an unused one.
    fetchAll<{ id: string; category_id: string; status: string }>(
      () => supabase.from("expenses").select("id, category_id, status").is("deleted_at", null),
      "id"
    ),
  ]);

  const usage: Record<string, number> = {};
  const nonRejected: Record<string, number> = {};
  for (const e of allExpenses) {
    usage[e.category_id] = (usage[e.category_id] ?? 0) + 1;
    if (e.status !== "rejected") {
      nonRejected[e.category_id] = (nonRejected[e.category_id] ?? 0) + 1;
    }
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const all = (categoriesRes.data ?? []) as any[];

  const categories: CategoryRow[] = all
    .filter((c) => c.status === "active")
    .map((c) => ({
      id: c.id,
      name: c.name,
      sort_order: c.sort_order,
      active: c.active,
      expense_count: usage[c.id] ?? 0,
    }));

  const proposed: ProposedCategoryRow[] = all
    .filter((c) => c.status === "proposed")
    .map((c) => ({
      id: c.id,
      name: c.name,
      shop_name: c.shops?.name ?? null,
      shop_color_key: c.shops?.color_key ?? null,
      expense_count: usage[c.id] ?? 0,
      non_rejected_count: nonRejected[c.id] ?? 0,
    }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return <ExpenseCategoriesView categories={categories} proposed={proposed} />;
}
