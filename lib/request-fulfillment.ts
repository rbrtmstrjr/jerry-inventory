/**
 * Classify a shop's delivery-request lines against master availability, for the
 * "Convert to delivery" prefill. Pure + dependency-free so it's unit-testable
 * (scripts/test-convert-request.mjs imports it directly).
 *
 * Rules (decided in the add-on):
 *  • Part with master_qty > 0  → AVAILABLE, qty capped at min(requested, on-hand).
 *  • Part with master_qty === 0 → NO STOCK (shown disabled, never delivered).
 *  • Engine model: auto-pick up to `requested` in-master serials (first-come,
 *    never reusing a serial across lines). ≥1 matched → AVAILABLE (partial keeps
 *    its matched serials + a "short" caption); 0 matched → NO STOCK.
 */

export interface RequestLine {
  part_id: string | null;
  engine_model_id: string | null;
  qty_requested: number;
  part_name: string | null;
  part_sku: string | null;
  model_name: string | null;
}

export interface MasterPartAvail {
  part_id: string;
  master_qty: number;
}

export interface InMasterEngine {
  id: string;
  engine_model_id: string;
}

export interface AvailablePart {
  part_id: string;
  qty: string; // capped to on-hand, as a string for the form input
  requested: number;
  available: number;
}
export interface NoStockPart {
  part_id: string;
  name: string;
  sku: string | null;
  qty_requested: number;
}
export interface ShortEngine {
  name: string;
  requested: number;
  matched: number;
}
export interface NoStockEngine {
  name: string;
  qty_requested: number;
}

export interface ClassifiedRequest {
  availableParts: AvailablePart[];
  noStockParts: NoStockPart[];
  /** matched in-master serial ids to pre-select */
  engineIds: string[];
  /** models delivered partially (requested > matched) — caption only */
  shortEngines: ShortEngine[];
  noStockEngines: NoStockEngine[];
}

export function classifyRequestLines(
  lines: RequestLine[],
  masterParts: MasterPartAvail[],
  inMasterEngines: InMasterEngine[]
): ClassifiedRequest {
  const masterQtyById = new Map(masterParts.map((m) => [m.part_id, m.master_qty]));
  const availableParts: AvailablePart[] = [];
  const noStockParts: NoStockPart[] = [];
  const engineIds: string[] = [];
  const shortEngines: ShortEngine[] = [];
  const noStockEngines: NoStockEngine[] = [];
  const taken = new Set<string>();

  for (const l of lines) {
    if (l.part_id) {
      const available = masterQtyById.get(l.part_id) ?? 0;
      if (available > 0) {
        availableParts.push({
          part_id: l.part_id,
          qty: String(Math.min(l.qty_requested, available)),
          requested: l.qty_requested,
          available,
        });
      } else {
        noStockParts.push({
          part_id: l.part_id,
          name: l.part_name ?? "Unknown part",
          sku: l.part_sku,
          qty_requested: l.qty_requested,
        });
      }
    } else if (l.engine_model_id) {
      const pool = inMasterEngines.filter(
        (e) => e.engine_model_id === l.engine_model_id && !taken.has(e.id)
      );
      const matched = pool.slice(0, l.qty_requested);
      for (const e of matched) {
        taken.add(e.id);
        engineIds.push(e.id);
      }
      const name = l.model_name ?? "Engine";
      if (matched.length === 0) {
        noStockEngines.push({ name, qty_requested: l.qty_requested });
      } else if (matched.length < l.qty_requested) {
        shortEngines.push({ name, requested: l.qty_requested, matched: matched.length });
      }
    }
  }

  return { availableParts, noStockParts, engineIds, shortEngines, noStockEngines };
}
