import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ExpenseCategoriesView, type CategoryRow } from "./categories-view";

export const metadata: Metadata = { title: "Expense Categories" };

export default async function ExpenseCategoriesPage() {
  const supabase = await createClient();

  const [categoriesRes, usageRes] = await Promise.all([
    supabase
      .from("expense_categories")
      .select("id, name, sort_order, active")
      .is("deleted_at", null)
      .order("sort_order"),
    supabase.from("expenses").select("category_id").is("deleted_at", null),
  ]);

  const usage: Record<string, number> = {};
  for (const e of usageRes.data ?? []) {
    usage[e.category_id] = (usage[e.category_id] ?? 0) + 1;
  }

  const categories: CategoryRow[] = (categoriesRes.data ?? []).map((c) => ({
    ...c,
    expense_count: usage[c.id] ?? 0,
  }));

  return <ExpenseCategoriesView categories={categories} />;
}
