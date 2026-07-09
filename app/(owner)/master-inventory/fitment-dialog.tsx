"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import type { EngineModel, PartRow } from "@/lib/db-types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { setPartFitments } from "./actions";

export function FitmentDialog({
  part,
  models,
  currentFitments,
  onClose,
}: {
  part: PartRow | null;
  models: EngineModel[];
  /** engine_model_ids currently linked to the part */
  currentFitments: string[];
  onClose: () => void;
}) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (part) setSelected(new Set(currentFitments));
  }, [part, currentFitments]);

  async function onSave() {
    if (!part) return;
    setBusy(true);
    const res = await setPartFitments({
      part_id: part.id,
      engine_model_ids: [...selected],
    });
    setBusy(false);
    if (res.ok) {
      toast.success(`Fitment saved for ${part.name}`);
      onClose();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <Dialog open={part !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Fitment — {part?.name}</DialogTitle>
          <DialogDescription>
            Tick every engine model this part fits. Employees see this when
            selling (“fits Yamaha 40HP”).
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-72 flex-col gap-1 overflow-auto rounded-md border p-2">
          {models.map((m) => (
            <Label
              key={m.id}
              className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent"
            >
              <Checkbox
                checked={selected.has(m.id)}
                onCheckedChange={(v) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (v === true) next.add(m.id);
                    else next.delete(m.id);
                    return next;
                  })
                }
              />
              <span className="text-sm">
                {m.brand} {m.model}
                {m.horsepower != null && (
                  <span className="text-muted-foreground"> — {m.horsepower}HP</span>
                )}
              </span>
            </Label>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Save fitment ({selected.size})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
