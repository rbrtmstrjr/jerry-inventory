"use client";

import {
  centavosPerGramToPerKilo,
  formatCentavos,
  nearestGramGrid,
  parsePesosToCentavos,
  perKiloToCentavosPerGram,
} from "@/lib/format";

/**
 * Under a price box on a GRAM product: confirms the per-gram figure, or says
 * why a per-kilo price has none. Renders nothing for every other unit.
 */
export function GramPriceHint({ unit, perKilo }: { unit: string; perKilo: string }) {
  if (unit !== "g" || perKilo.trim() === "") return null;

  const perGram = perKiloToCentavosPerGram(perKilo);
  if (perGram !== null) {
    return (
      <p className="text-xs text-muted-foreground">
        = <span className="font-medium text-foreground tabular-nums">
          {formatCentavos(perGram)}
        </span>{" "}
        per gram
      </p>
    );
  }

  const raw = parsePesosToCentavos(perKilo);
  if (raw === null) return null;
  // Whole centavos only, so a per-kilo price must sit on a ₱10 grid.
  const { low, high } = nearestGramGrid(raw);
  return (
    <p className="text-xs text-destructive">
      {formatCentavos(raw)}/kg can&apos;t be priced per gram. Nearest:{" "}
      <span className="font-medium tabular-nums">{formatCentavos(low)}</span> or{" "}
      <span className="font-medium tabular-nums">{formatCentavos(high)}</span>.
    </p>
  );
}

/**
 * Read-only companion for surfaces that keep taking a PER-GRAM price — the
 * edit dialog and the receiving line's unit cost. Shows the kilo equivalent so
 * a per-kilo figure typed by mistake is obvious immediately.
 */
export function PerKiloEquivalent({ unit, perGram }: { unit: string; perGram: string }) {
  if (unit !== "g" || perGram.trim() === "") return null;
  const c = parsePesosToCentavos(perGram);
  if (c === null || c === 0) return null;
  return (
    <p className="text-xs text-muted-foreground">
      = <span className="font-medium text-foreground tabular-nums">
        {formatCentavos(centavosPerGramToPerKilo(c))}
      </span>{" "}
      per kilo
    </p>
  );
}
