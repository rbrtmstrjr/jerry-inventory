import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { SettingsForm } from "./settings-form";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("settings")
    .select("business_name, address, phone, receipt_footer, default_warranty_months")
    .eq("id", 1)
    .single();

  return (
    <SettingsForm
      settings={
        data ?? {
          business_name: "Maccky's Marine",
          address: null,
          phone: null,
          receipt_footer: null,
          default_warranty_months: 12,
        }
      }
    />
  );
}
