import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { SuppliersTable } from "./suppliers-table";

export const metadata: Metadata = { title: "Suppliers" };

export default async function SuppliersPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("suppliers")
    .select("id, name, contact, notes")
    .is("deleted_at", null)
    .order("name");

  return <SuppliersTable suppliers={data ?? []} />;
}
