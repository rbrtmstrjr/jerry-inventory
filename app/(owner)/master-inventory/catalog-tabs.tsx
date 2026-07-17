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
  fitmentsByPart,
  pricesByPart,
}: {
  parts: PartRow[];
  engines: EngineRow[];
  categories: Category[];
  models: EngineModel[];
  fitmentsByPart: Record<string, string[]>;
  pricesByPart: Record<string, ComparisonRow[]>;
}) {
  return (
    <Tabs defaultValue="parts">
      <TabsList>
        <TabsTrigger value="parts">
          Parts &amp; Goods ({parts.length})
        </TabsTrigger>
        <TabsTrigger value="engines">Engines ({engines.length})</TabsTrigger>
      </TabsList>
      <TabsContent value="parts" className="pt-2">
        <PartsTable
          parts={parts}
          categories={categories}
          models={models}
          fitmentsByPart={fitmentsByPart}
          pricesByPart={pricesByPart}
        />
      </TabsContent>
      <TabsContent value="engines" className="pt-2">
        <EnginesTable engines={engines} models={models} />
      </TabsContent>
    </Tabs>
  );
}
