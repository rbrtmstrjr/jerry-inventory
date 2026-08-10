"use client";

import * as React from "react";

import { createClient } from "@/lib/supabase/client";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface UnitOption {
  code: string;
  label: string;
  allows_fractional: boolean;
}

/**
 * The product's unit, chosen from a controlled list — never typed.
 *
 * This is not tidiness. Since 0116 a quantity may be a tenth, and WHICH
 * products may be sold that way is decided by the unit: kilos yes, pieces no.
 * While `parts.unit` was free text, "kg" / "kilo" / "kls" / "Kg" all behaved
 * differently and the rule hinged on spelling. The dropdown is what makes the
 * unit trustworthy enough to key a business rule on.
 *
 * Units are reference data the office manages (public.units, migration 0114),
 * so selling rope by the metre is a new row rather than a code change.
 */
export function UnitSelect({
  value,
  onChange,
  id,
  className,
  disabled,
}: {
  value: string;
  onChange: (code: string) => void;
  id?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [units, setUnits] = React.useState<UnitOption[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    createClient()
      .from("units")
      .select("code, label, allows_fractional")
      .is("deleted_at", null)
      .order("sort_order")
      .then(({ data }) => {
        if (!cancelled && data) setUnits(data as UnitOption[]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} className={className ?? "w-full"}>
        <SelectValue placeholder="Piece" />
      </SelectTrigger>
      <SelectContent>
        {units.map((u) => (
          <SelectItem key={u.code} value={u.code}>
            {u.label}
            {/* Say it in the picker: choosing this is what makes the quantity
                editable at the counter. Otherwise the connection is invisible
                and the owner wonders why nails can't be sold by the half. */}
            {u.allows_fractional && (
              /* Unit-neutral since 0130: metres, feet and rolls are splittable
                 too, so "sold by weight" was wrong for three of the four. */
              <span className="ml-2 text-xs text-muted-foreground">
                sold in parts
              </span>
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Units, for callers that need `allows_fractional` rather than a picker. */
export function useUnits(): UnitOption[] {
  const [units, setUnits] = React.useState<UnitOption[]>([]);
  React.useEffect(() => {
    let cancelled = false;
    createClient()
      .from("units")
      .select("code, label, allows_fractional")
      .is("deleted_at", null)
      .order("sort_order")
      .then(({ data }) => {
        if (!cancelled && data) setUnits(data as UnitOption[]);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return units;
}
