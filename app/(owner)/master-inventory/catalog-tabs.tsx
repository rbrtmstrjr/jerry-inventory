"use client";

import type { ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * The catalog tab shell — renders the Parts/Engines tab bar INSTANTLY and takes
 * the ACTIVE tab's table as a slot (a <Suspense> boundary in the server page),
 * so the bar paints immediately while the table streams in behind a skeleton.
 *
 * URL-driven (`?tab=`): previously both slots were rendered, so opening Parts
 * still fetched every engine too. Now the server builds only the open tab, and
 * switching tabs is a navigation that fetches just that tab's page of rows.
 */
export function CatalogTabs({
  activeTab,
  children,
}: {
  activeTab: "parts" | "engines";
  children: ReactNode;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  /** A new tab is a new list — drop the previous tab's paging/sort/search. */
  function go(tab: string) {
    if (tab === activeTab) return;
    const view = searchParams.get("view");
    const p = new URLSearchParams();
    if (tab !== "parts") p.set("tab", tab);
    if (view) p.set("view", view);
    const qs = p.toString();
    router.push(qs ? `/master-inventory?${qs}` : "/master-inventory");
  }

  return (
    <Tabs value={activeTab} onValueChange={go}>
      <TabsList>
        <TabsTrigger value="parts">Parts &amp; Goods</TabsTrigger>
        <TabsTrigger value="engines">Engines</TabsTrigger>
      </TabsList>
      <TabsContent value={activeTab} className="pt-2">
        {children}
      </TabsContent>
    </Tabs>
  );
}
