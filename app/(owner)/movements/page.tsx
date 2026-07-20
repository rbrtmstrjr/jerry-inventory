import type { Metadata } from "next";

import { createClient } from "@/lib/supabase/server";
import { ph_today } from "@/lib/ph-date";
import { MovementTabs } from "./movement-tabs";
import { JournalView } from "./journal-view";
import { StockCardView } from "./stock-card-view";
import { EngineHistoryView } from "./engine-history-view";
import type { EngineLife, JournalRow, StockCardRow } from "./types";

export const metadata: Metadata = { title: "Movements" };

const PAGE_SIZE = 50;

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * The ledger, as a book.
 *
 * Read-only throughout: there is no action on this page, no form, no button
 * that writes. `stock_movements` has no INSERT/UPDATE/DELETE policy for anyone
 * — not even the owner — so this could not mutate the ledger even if it tried.
 */
export default async function MovementsPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    from?: string; to?: string;
    location?: string; type?: string; product?: string; actor?: string; q?: string;
    page?: string;
    part?: string; shop?: string; serial?: string;
  }>;
}) {
  const sp = await searchParams;
  const tab =
    sp.tab === "ledger" ? "ledger" : sp.tab === "engines" ? "engines" : "journal";
  const supabase = await createClient();
  const today = ph_today();

  const heading = (
    <div className="print:hidden">
      <h1 className="text-2xl font-semibold tracking-tight">Movements</h1>
      <p className="text-sm text-muted-foreground">
        Every stock movement ever recorded. Append-only — nothing here can be
        edited or deleted.
      </p>
    </div>
  );

  // ── Stock Card ──────────────────────────────────────────────────────────
  if (tab === "ledger") {
    const to = isDate(sp.to) ? sp.to! : today;
    const from = isDate(sp.from) ? sp.from! : addDays(to, -30);
    const partId = sp.part ?? null;
    // "master" is a real location, and it is NOT null-as-in-unset. `shop` absent
    // means the user hasn't picked yet; shop=master means the master warehouse.
    const shopParam = sp.shop ?? null;
    const shopId = shopParam && shopParam !== "master" ? shopParam : null;

    const [partsRes, shopsRes, cardRes] = await Promise.all([
      supabase.from("parts").select("id, name, sku, unit").is("deleted_at", null).order("name"),
      supabase.from("shops").select("id, name, color_key, deleted_at").order("name"),
      partId
        ? supabase.rpc("fn_stock_card", {
            p_part_id: partId, p_shop_id: shopId, p_from: from, p_to: to,
          })
        : Promise.resolve({ data: null, error: null }),
    ]);

    // The closing balance's whole job is to equal live stock, so show what live
    // stock actually is and let the card be checked against it on sight.
    let liveQty: number | null = null;
    if (partId) {
      const q = supabase.from("stock_levels").select("qty").eq("part_id", partId);
      const { data } = await (shopId ? q.eq("shop_id", shopId) : q.is("shop_id", null)).maybeSingle();
      liveQty = data?.qty ?? 0;
    }

    return (
      <div className="flex flex-col gap-4">
        {heading}
        <MovementTabs active="ledger" />
        <StockCardView
          from={from}
          to={to}
          partId={partId}
          shopParam={shopParam}
          parts={partsRes.data ?? []}
          shops={(shopsRes.data ?? []).map((s) => ({ ...s, closed: !!s.deleted_at }))}
          rows={(cardRes.data ?? []) as StockCardRow[]}
          liveQty={liveQty}
          today={today}
        />
      </div>
    );
  }

  // ── Engine chain of custody ─────────────────────────────────────────────
  if (tab === "engines") {
    const serial = (sp.serial ?? "").trim();
    let life: EngineLife | null = null;

    if (serial) {
      const { data: eng } = await supabase
        .from("engines")
        .select(
          `id, serial_number, status, shop_id, cost_centavos, sold_at, deleted_at,
           engine_models(brand, model, horsepower),
           customers(name, phone),
           shops(name)`
        )
        .ilike("serial_number", serial)
        .maybeSingle();

      if (eng) {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const e = eng as any;
        const [movesRes, warrantyRes] = await Promise.all([
          supabase
            .from("movement_journal")
            .select("*")
            .eq("engine_id", e.id)
            .order("created_at")
            .order("id"),
          supabase
            .from("warranties")
            .select("id, sold_on, months, expires_on, warranty_claims(id, claim_date, issue, status)")
            .eq("engine_id", e.id)
            .maybeSingle(),
        ]);

        life = {
          engine_id: e.id,
          serial_number: e.serial_number,
          brand: e.engine_models?.brand ?? null,
          model: e.engine_models?.model ?? null,
          horsepower: e.engine_models?.horsepower ?? null,
          status: e.deleted_at ? "written_off" : e.status,
          shop_name: e.shops?.name ?? null,
          cost_centavos: e.cost_centavos,
          sold_at: e.sold_at,
          customer_name: e.customers?.name ?? null,
          customer_phone: e.customers?.phone ?? null,
          movements: (movesRes.data ?? []) as JournalRow[],
          warranty: warrantyRes.data
            ? {
                id: warrantyRes.data.id,
                sold_on: warrantyRes.data.sold_on,
                months: warrantyRes.data.months,
                expires_on: warrantyRes.data.expires_on,
                claims: (warrantyRes.data as any).warranty_claims ?? [],
              }
            : null,
        };
        /* eslint-enable @typescript-eslint/no-explicit-any */
      }
    }

    return (
      <div className="flex flex-col gap-4">
        {heading}
        <MovementTabs active="engines" />
        <EngineHistoryView serial={serial} life={life} today={today} />
      </div>
    );
  }

  // ── Journal ─────────────────────────────────────────────────────────────
  const to = isDate(sp.to) ? sp.to! : today;
  const from = isDate(sp.from) ? sp.from! : addDays(to, -30);
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  // Filtered and paginated IN POSTGRES. This table is append-only and grows
  // forever; fetching it whole to filter in the browser would work today and
  // fall over quietly in a year.
  let q = supabase
    .from("movement_journal")
    .select("*", { count: "exact" })
    // PH day boundaries. created_at is an instant, so comparing it to a bare
    // date would use UTC midnight and misfile 8 hours of movements.
    .gte("created_at", `${from}T00:00:00+08:00`)
    .lte("created_at", `${to}T23:59:59.999+08:00`);

  if (sp.location === "master") q = q.eq("location_kind", "master");
  else if (sp.location === "transit") q = q.eq("location_kind", "transit");
  else if (sp.location && sp.location !== "all") q = q.eq("shop_id", sp.location);

  if (sp.type && sp.type !== "all") q = q.eq("movement_type", sp.type);
  if (sp.product) q = q.eq("part_id", sp.product);
  if (sp.actor && sp.actor !== "all") q = q.eq("actor", sp.actor);
  if (sp.q?.trim()) q = q.ilike("search_text", `%${sp.q.trim().toLowerCase()}%`);

  const [journalRes, shopsRes, partsRes, actorsRes] = await Promise.all([
    q
      // Newest first, `id` as the tiebreaker so same-timestamp rows can't swap
      // between page loads and duplicate/skip across a page boundary.
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1),
    supabase.from("shops").select("id, name, color_key").order("name"),
    supabase.from("parts").select("id, name").is("deleted_at", null).order("name"),
    supabase.from("profiles").select("id, full_name").order("full_name"),
  ]);

  return (
    <div className="flex flex-col gap-4">
      {heading}
      <MovementTabs active="journal" />
      <JournalView
        rows={(journalRes.data ?? []) as JournalRow[]}
        total={journalRes.count ?? 0}
        page={page}
        pageSize={PAGE_SIZE}
        filters={{
          from, to,
          location: sp.location ?? "all",
          type: sp.type ?? "all",
          product: sp.product ?? "",
          actor: sp.actor ?? "all",
          q: sp.q ?? "",
        }}
        shops={shopsRes.data ?? []}
        parts={partsRes.data ?? []}
        actors={actorsRes.data ?? []}
      />
    </div>
  );
}
