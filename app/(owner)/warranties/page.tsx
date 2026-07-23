import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/pnl";
import { ph_today } from "@/lib/ph-date";
import {
  WarrantiesView,
  type WarrantyRow,
  type SerialRow,
  type PendingClaimRow,
} from "./warranties-view";

export const metadata: Metadata = { title: "Warranties & Serials" };

export default async function WarrantiesPage() {
  const supabase = await createClient();

  const [allWarranties, allEngines, shopsRes, pendingClaimsRes] = await Promise.all([
    // Paginated (keyset by id): both lists grow past 1,000 — the serial
    // registry especially, which holds every engine ever received. The view
    // re-sorts client-side, so the fetch order doesn't matter.
    fetchAll(
      () =>
        supabase
          .from("warranties")
          .select(
            `id, engine_id, sold_on, months, expires_on,
             engines(serial_number, engine_models(brand, model, horsepower)),
             customers(name, phone),
             sales(shops(name, color_key)),
             warranty_claims(id, claim_date, issue, action_taken)`
          )
          .is("deleted_at", null),
      "id"
    ),
    // every serial ever received — including sold and written-off
    fetchAll(
      () =>
        supabase
          .from("engines")
          .select(
            "id, serial_number, status, deleted_at, sold_at, engine_models(brand, model, horsepower), shops(name, color_key), customers(name, phone)"
          ),
      "id"
    ),
    supabase.from("shops").select("id, name, color_key").is("deleted_at", null).order("name"),
    // shop-filed claims awaiting the owner's decision (0070)
    supabase
      .from("warranty_claims")
      .select(
        `id, status, resolution, issue, refund_centavos, created_at, shop_id,
         shops(name, color_key),
         warranties(engines(serial_number, engine_models(brand, model, horsepower)),
                    customers(name, phone)),
         replacement:engines!warranty_claims_replacement_engine_id_fkey(serial_number)`
      )
      .eq("status", "requested")
      .is("deleted_at", null)
      .order("created_at", { ascending: true }),
  ]);

  const today = ph_today();

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const warranties: WarrantyRow[] = (allWarranties as any[]).map((w: any) => ({
    id: w.id,
    engine_id: w.engine_id,
    serial_number: w.engines?.serial_number ?? "?",
    model: `${w.engines?.engine_models?.brand ?? ""} ${w.engines?.engine_models?.model ?? ""}`.trim(),
    horsepower: w.engines?.engine_models?.horsepower ?? null,
    customer: w.customers?.name ?? "?",
    customer_phone: w.customers?.phone ?? null,
    shop: w.sales?.shops?.name ?? null,
    shop_color_key: w.sales?.shops?.color_key ?? null,
    sold_on: w.sold_on,
    months: w.months,
    expires_on: w.expires_on,
    active: w.expires_on >= today,
    claims: (w.warranty_claims ?? [])
      .sort((a: any, b: any) => (a.claim_date < b.claim_date ? 1 : -1))
      .map((c: any) => ({
        id: c.id,
        claim_date: c.claim_date,
        issue: c.issue,
        action_taken: c.action_taken,
      })),
  }));

  const serials: SerialRow[] = (allEngines as any[]).map((e: any) => ({
    id: e.id,
    serial_number: e.serial_number,
    model: `${e.engine_models?.brand ?? ""} ${e.engine_models?.model ?? ""}`.trim(),
    horsepower: e.engine_models?.horsepower ?? null,
    status: e.deleted_at ? "written_off" : e.status,
    shop: e.shops?.name ?? null,
    shop_color_key: e.shops?.color_key ?? null,
    customer: e.customers?.name ?? null,
    customer_phone: e.customers?.phone ?? null,
    sold_at: e.sold_at,
  }));
  const pendingClaims: PendingClaimRow[] = (pendingClaimsRes.data ?? []).map(
    (c: any) => ({
      id: c.id,
      resolution: c.resolution,
      issue: c.issue,
      refund_centavos: c.refund_centavos,
      created_at: c.created_at,
      shop: c.shops?.name ?? "?",
      shop_color_key: c.shops?.color_key ?? null,
      serial_number: c.warranties?.engines?.serial_number ?? "?",
      model: `${c.warranties?.engines?.engine_models?.brand ?? ""} ${c.warranties?.engines?.engine_models?.model ?? ""}`.trim(),
      customer: c.warranties?.customers?.name ?? null,
      replacement_serial: c.replacement?.serial_number ?? null,
    })
  );
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <WarrantiesView
      warranties={warranties}
      serials={serials}
      today={today}
      shops={shopsRes.data ?? []}
      pendingClaims={pendingClaims}
    />
  );
}
