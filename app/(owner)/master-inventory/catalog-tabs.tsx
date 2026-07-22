"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Category, EngineModel, EngineRow, PartRow } from "@/lib/db-types";
import { PartsTable } from "./parts-table";
import { EnginesTable } from "./engines-table";
import type { ComparisonRow } from "./supplier-prices-dialog";

export function CatalogTabs({
  parts,
  engines,
  categories,
  models,
  suppliers,
  fitmentsByPart,
  pricesByPart,
}: {
  parts: PartRow[];
  engines: EngineRow[];
  categories: Category[];
  models: EngineModel[];
  suppliers: { id: string; name: string }[];
  fitmentsByPart: Record<string, string[]>;
  pricesByPart: Record<string, ComparisonRow[]>;
}) {
  return (
    <Tabs defaultValue="parts">
      <TabsList>
        <TabsTrigger value="parts">Parts &amp; Goods</TabsTrigger>
        <TabsTrigger value="engines">Engines</TabsTrigger>
      </TabsList>
      <TabsContent value="parts" className="pt-2">
        <PartsTable
          parts={parts}
          categories={categories}
          models={models}
          suppliers={suppliers}
          fitmentsByPart={fitmentsByPart}
          pricesByPart={pricesByPart}
        />
      </TabsContent>
      <TabsContent value="engines" className="pt-2">
        <EnginesTable engines={engines} models={models} suppliers={suppliers} />
      </TabsContent>
    </Tabs>
  );
}
