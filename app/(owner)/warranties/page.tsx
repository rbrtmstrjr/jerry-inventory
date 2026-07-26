import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { ph_today } from "@/lib/ph-date";
import { Skeleton } from "@/components/ui/skeleton";
import { TableSkeleton } from "@/components/shell/streaming-skeletons";
import { parseTableParams } from "@/components/data-table/table-params";
import {
  WarrantiesView,
  type WarrantyRow,
  type SerialRow,
  type PendingClaimRow,
} from "./warranties-view";

export const metadata: Metadata = { title: "Warranties & Serials" };

type SP = Record<string, string | string[] | undefined>;

/** Re-suspend key: everything EXCEPT `q`. Including the search term would
 *  remount the subtree on every debounced keystroke — destroying the search
 *  box (focus loss) and flashing the skeleton while you are still typing.
 *  Search instead re-renders in place behind the table's own pending state. */
function suspenseKey(sp: Record<string, string | string[] | undefined>) {
  return JSON.stringify(
    Object.entries(sp)
      .filter(([k]) => k !== "q")
      .sort(([a], [b]) => a.localeCompare(b))
  );
}


/**
 * Shell: heading + tabs paint instantly; only the ACTIVE tab's page of rows is
 * fetched, sliced in SQL. Previously this pulled every warranty AND every
 * engine into the browser (deep joins, all rows) to paginate client-side, which
 * scaled with the size of the tables. Now the cost is one page of rows.
 */
export default async function WarrantiesPage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const sp = await searchParams;
  const tab = (Array.isArray(sp.tab) ? sp.tab[0] : sp.tab) ?? "";

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Warranties &amp; Serials
        </h1>
        <p className="text-sm text-muted-foreground">
          Every engine serial and its warranty across all shops — search any
          serial to see who bought it, where, and when.
        </p>
      </div>
      {/* Re-suspend on any tab/filter/page change so the skeleton shows again */}
      <Suspense key={suspenseKey(sp)} fallback={<WarrantiesSkeleton />}>
        <WarrantiesBody sp={sp} tab={tab} />
      </Suspense>
    </div>
  );
}

async function WarrantiesBody({ sp, tab }: { sp: SP; tab: string }) {
  const supabase = await createClient();
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const shopFilter = one(sp.shop) ?? "all";

  const head = { count: "exact" as const, head: true };
  // Counts drive the tab badges — cheap (no rows leave the database).
  const [claimsRes, shopsRes, wCount, sCount] = await Promise.all([
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
    supabase.from("shops").select("id, name, color_key").is("deleted_at", null).order("name"),
    supabase.from("warranty_registry").select("*", head),
    supabase.from("engine_registry").select("*", head),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const pendingClaims: PendingClaimRow[] = (claimsRes.data ?? []).map((c: any) => ({
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
  }));

  // Land on Approval when there are claims to act on, else on Warranty.
  const active = tab || (pendingClaims.length > 0 ? "approval" : "warranty");

  let warranties: WarrantyRow[] = [];
  let serials: SerialRow[] = [];
  let total = 0;
  const params = parseTableParams(sp, {
    defaultSort: active === "serials" ? "created_at" : "sold_on",
    defaultDir: "desc",
    sortable:
      active === "serials"
        ? ["created_at", "serial_number", "model", "status", "shop", "sold_at"]
        : ["sold_on", "expires_on", "shop", "serial_number", "customer"],
  });
  const from = (params.page - 1) * params.pageSize;
  const to = from + params.pageSize - 1;

  if (active === "warranty") {
    let query = supabase.from("warranty_registry").select("*", { count: "exact" });
    if (shopFilter !== "all") query = query.eq("shop", shopFilter);
    if (params.q) query = query.ilike("search_text", `%${params.q.toLowerCase()}%`);
    const res = await query
      .order(params.sort ?? "sold_on", { ascending: params.dir === "asc" })
      .range(from, to);
    total = res.count ?? 0;

    // Claims only for the rows on THIS page — bounded by page size, so the
    // dialog keeps its history without loading every claim in the business.
    const ids = (res.data ?? []).map((w: any) => w.id);
    const claimsByWarranty = new Map<string, any[]>();
    if (ids.length) {
      const { data: cl } = await supabase
        .from("warranty_claims")
        .select("id, warranty_id, claim_date, issue, action_taken")
        .in("warranty_id", ids)
        .is("deleted_at", null);
      for (const c of cl ?? []) {
        const arr = claimsByWarranty.get(c.warranty_id) ?? [];
        arr.push(c);
        claimsByWarranty.set(c.warranty_id, arr);
      }
    }

    warranties = (res.data ?? []).map((w: any) => ({
      id: w.id,
      engine_id: w.engine_id,
      serial_number: w.serial_number ?? "?",
      model: w.model ?? "",
      horsepower: w.horsepower,
      customer: w.customer ?? "?",
      customer_phone: w.customer_phone,
      shop: w.shop,
      shop_color_key: w.shop_color_key,
      sold_on: w.sold_on,
      months: w.months,
      expires_on: w.expires_on,
      active: w.active,
      claims: (claimsByWarranty.get(w.id) ?? [])
        .sort((a: any, b: any) => (a.claim_date < b.claim_date ? 1 : -1))
        .map((c: any) => ({
          id: c.id,
          claim_date: c.claim_date,
          issue: c.issue,
          action_taken: c.action_taken,
        })),
    }));
  } else if (active === "serials") {
    let query = supabase.from("engine_registry").select("*", { count: "exact" });
    if (params.q) query = query.ilike("search_text", `%${params.q.toLowerCase()}%`);
    const res = await query
      .order(params.sort ?? "created_at", { ascending: params.dir === "asc" })
      .range(from, to);
    total = res.count ?? 0;
    serials = (res.data ?? []).map((e: any) => ({
      id: e.id,
      serial_number: e.serial_number,
      model: e.model ?? "",
      horsepower: e.horsepower,
      status: e.status,
      shop: e.shop,
      shop_color_key: e.shop_color_key,
      customer: e.customer,
      customer_phone: e.customer_phone,
      sold_at: e.sold_at,
    }));
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <WarrantiesView
      warranties={warranties}
      serials={serials}
      today={ph_today()}
      shops={shopsRes.data ?? []}
      pendingClaims={pendingClaims}
      activeTab={active}
      shopFilter={shopFilter}
      total={total}
      page={params.page}
      pageSize={params.pageSize}
      q={params.q}
      warrantyCount={wCount.count ?? 0}
      serialCount={sCount.count ?? 0}
    />
  );
}

function WarrantiesSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-28" />
      </div>
      <TableSkeleton cols={6} toolbar={false} />
    </div>
  );
}
