import type { Metadata } from "next";
import { Suspense } from "react";

import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/pnl";
import { TableSkeleton } from "@/components/shell/streaming-skeletons";
import { SukiCardsView, type CardRow } from "./suki-cards-view";

export const metadata: Metadata = { title: "Suki Cards" };

/**
 * Suki discount cards — the physical cards are printed by a separate system;
 * here the owner records each card's barcode number against a customer, and a
 * shop scans it at Record Sale so the engine/part percentages apply
 * automatically. Rates are Settings dials (Settings → Alerts).
 *
 * Shell: the heading paints instantly; the card table streams behind a skeleton.
 */
export default function SukiCardsPage() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Suki Cards</h1>
        <p className="text-sm text-muted-foreground">
          Record the barcode number of each printed loyalty card — a scan at
          Record Sale then applies the suki discount automatically (set the
          rates in Settings → Alerts).
        </p>
      </div>
      <Suspense fallback={<TableSkeleton cols={5} />}>
        <SukiCardsBody />
      </Suspense>
    </div>
  );
}

async function SukiCardsBody() {
  const supabase = await createClient();

  const [cardsRes, allUsage, customersRes, settingsRes] = await Promise.all([
    supabase
      .from("discount_cards")
      .select("id, card_no, status, issued_at, note, customer_id, customers(name, phone)")
      .is("deleted_at", null)
      .order("issued_at", { ascending: false }),
    // program usage per card — count + what the card saved the suki. Paginated:
    // card sales accumulate past 1,000 over time, which undercounted usage.
    fetchAll(
      () =>
        supabase
          .from("sales")
          .select("id, discount_card_id, card_discount_centavos")
          .not("discount_card_id", "is", null)
          .is("deleted_at", null),
      "id"
    ),
    supabase
      .from("customers")
      .select("id, name, phone")
      .is("deleted_at", null)
      .order("name")
      .limit(1000),
    supabase
      .from("settings")
      .select("suki_engine_discount_pct, suki_part_discount_pct")
      .eq("id", 1)
      .single(),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const usage = new Map<string, { count: number; saved: number }>();
  for (const s of allUsage as any[]) {
    const u = usage.get(s.discount_card_id as string) ?? { count: 0, saved: 0 };
    u.count += 1;
    u.saved += (s.card_discount_centavos as number) ?? 0;
    usage.set(s.discount_card_id as string, u);
  }

  const cards: CardRow[] = (cardsRes.data ?? []).map((c: any) => ({
    id: c.id,
    card_no: c.card_no,
    status: c.status,
    issued_at: c.issued_at,
    note: c.note,
    customer_id: c.customer_id,
    customer_name: c.customers?.name ?? "?",
    customer_phone: c.customers?.phone ?? null,
    uses: usage.get(c.id)?.count ?? 0,
    saved_centavos: usage.get(c.id)?.saved ?? 0,
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <SukiCardsView
      cards={cards}
      customers={customersRes.data ?? []}
      enginePct={settingsRes.data?.suki_engine_discount_pct ?? 10}
      partPct={settingsRes.data?.suki_part_discount_pct ?? 5}
    />
  );
}
