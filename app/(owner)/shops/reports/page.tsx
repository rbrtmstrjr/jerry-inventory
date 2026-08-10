import { redirect } from "next/navigation";

/** Moved to /reports?tab=shops. This stub keeps old bookmarks alive and carries
 *  the query string, so ?shop=X still lands on the same branch. */
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
