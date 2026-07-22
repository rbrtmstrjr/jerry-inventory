import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { CategoriesView } from "./categories-view";

export const metadata: Metadata = { title: "Categories" };

export default async function CategoriesPage() {
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
