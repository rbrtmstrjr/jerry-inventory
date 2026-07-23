"use client";

import type { ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * The catalog tab shell. It renders the Parts/Engines tab bar INSTANTLY and
 * takes each tab's table as a slot — the slots are <Suspense> boundaries in the
 * server page, so the tab bar paints immediately while the (heavy) tables stream
 * in behind their own skeletons. Same idea as the Suppliers tabs: don't skeleton
 * the whole page, only the data.
 */
export function CatalogTabs({
  partsSlot,
  enginesSlot,
}: {
  partsSlot: ReactNode;
  enginesSlot: ReactNode;
}) {
  return (
    <Tabs defaultValue="parts">
      <TabsList>
        <TabsTrigger value="parts">Parts &amp; Goods</TabsTrigger>
        <TabsTrigger value="engines">Engines</TabsTrigger>
      </TabsList>
      <TabsContent value="parts" className="pt-2">
        {partsSlot}
      </TabsContent>
      <TabsContent value="engines" className="pt-2">
        {enginesSlot}
      </TabsContent>
    </Tabs>
  );
}
