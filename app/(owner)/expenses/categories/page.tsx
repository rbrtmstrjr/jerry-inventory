import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
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

  const [categoriesRes, usageRes] = await Promise.all([
    supabase
      .from("expense_categories")
      .select("id, name, sort_order, active, status, shops(name, color_key)")
      .is("deleted_at", null)
      .order("sort_order"),
    supabase
      .from("expenses")
      .select("category_id, status")
      .is("deleted_at", null),
  ]);

  const usage: Record<string, number> = {};
  const nonRejected: Record<string, number> = {};
  for (const e of usageRes.data ?? []) {
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
