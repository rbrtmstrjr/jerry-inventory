import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { LabelPrinter } from "./label-printer";

export const metadata: Metadata = { title: "Print Labels" };

export default async function LabelsPage({
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
