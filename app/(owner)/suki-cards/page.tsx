import type { Metadata } from "next";

import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/pnl";
import { SukiCardsView, type CardRow } from "./suki-cards-view";

export const metadata: Metadata = { title: "Suki Cards" };

/**
 * Suki discount cards — the owner produces a card per loyal customer; a shop
 * scans it at Record Sale and the engine/part percentages apply automatically.
 * Rates are Settings dials (Settings → Alerts); this page manages the cards.
 */
export default async function SukiCardsPage() {
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

  const usage = new Map<string, { count: number; saved: number }>();
  for (const s of allUsage as any[]) {
    const u = usage.get(s.discount_card_id as string) ?? { count: 0, saved: 0 };
    u.count += 1;
    u.saved += (s.card_discount_centavos as number) ?? 0;
    usage.set(s.discount_card_id as string, u);
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
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
