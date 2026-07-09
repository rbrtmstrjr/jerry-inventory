import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { BulkAddForm } from "./bulk-add-form";

export const metadata: Metadata = { title: "Bulk Add" };

export default async function BulkAddPage() {
  const supabase = await createClient();
  const { data: categories } = await supabase
    .from("product_categories")
    .select("id, name")
    .is("deleted_at", null)
    .order("name");

  return <BulkAddForm categories={categories ?? []} />;
}
