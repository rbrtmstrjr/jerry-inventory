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

/** The unit is CHOSEN, never typed — it decides which products sell in fractions,
 *  and free text made that rule hinge on spelling. Reference data, not code. */
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
