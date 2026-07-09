"use client";

import * as React from "react";
import { LayoutGrid, Table2 } from "lucide-react";

import { Button } from "@/components/ui/button";

export type ViewMode = "table" | "cards";

/** Table ⇄ card-grid switcher; remembers the choice per screen. */
export function ViewToggle({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  return (
    <div className="flex rounded-lg border p-0.5">
      <Button
        type="button"
        variant={value === "table" ? "secondary" : "ghost"}
        size="icon-sm"
        aria-label="Table view"
        aria-pressed={value === "table"}
        onClick={() => onChange("table")}
      >
        <Table2 />
      </Button>
      <Button
        type="button"
        variant={value === "cards" ? "secondary" : "ghost"}
        size="icon-sm"
        aria-label="Card view"
        aria-pressed={value === "cards"}
        onClick={() => onChange("cards")}
      >
        <LayoutGrid />
      </Button>
    </div>
  );
}

/** localStorage-persisted view mode (defaults to table). */
export function usePersistedView(key: string): [ViewMode, (v: ViewMode) => void] {
  const [view, setView] = React.useState<ViewMode>("table");

  React.useEffect(() => {
    const saved = localStorage.getItem(key);
    if (saved === "cards" || saved === "table") setView(saved);
  }, [key]);

  const update = React.useCallback(
    (v: ViewMode) => {
      setView(v);
      try {
        localStorage.setItem(key, v);
      } catch {
        /* storage blocked — non-fatal */
      }
    },
    [key]
  );

  return [view, update];
}
