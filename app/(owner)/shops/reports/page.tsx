import { redirect } from "next/navigation";

/**
 * Per-shop profitability moved to /reports?tab=shops — it's financial
 * reporting sharing lib/pnl.ts with the P&L, not shop management. This stub
 * keeps old bookmarks alive and carries the query along, so a saved
 * "/shops/reports?shop=X" link still lands on the same branch's numbers.
 */
export default async function ShopReportsMovedStub({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; shop?: string }>;
}) {
  const params = await searchParams;
  const p = new URLSearchParams({ tab: "shops" });
  if (params.from) p.set("from", params.from);
  if (params.to) p.set("to", params.to);
  if (params.shop) p.set("shop", params.shop);
  redirect(`/reports?${p.toString()}`);
}
