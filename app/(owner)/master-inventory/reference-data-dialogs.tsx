"use client";

import * as React from "react";
import { Archive, Loader2, Save } from "lucide-react";
import { toast } from "sonner";

import type { EngineModel } from "@/lib/db-types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { softDeleteEngineModel, updateEngineModel } from "./actions";

/**
 * Reference data is CREATED at receiving only (0049 revoked direct INSERT);
 * here it is edited or retired — fixing a typo'd model name or deactivating a
 * discontinued model must not require a receiving.
 */
export function ModelManagerDialog({
  open,
  models,
  onClose,
}: {
  open: boolean;
  models: EngineModel[];
  onClose: () => void;
}) {
  interface Row {
    id: string;
    brand: string;
    model: string;
    horsepower: string;
    stroke: "" | "2-stroke" | "4-stroke";
    warranty: string;
  }
  const [rows, setRows] = React.useState<Row[]>([]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [retiring, setRetiring] = React.useState<Row | null>(null);

  React.useEffect(() => {
    if (open) {
      setRows(
        models.map((m) => ({
          id: m.id,
          brand: m.brand,
          model: m.model,
          horsepower: m.horsepower != null ? String(m.horsepower) : "",
          stroke: (m.stroke as Row["stroke"]) ?? "",
          warranty: String(m.default_warranty_months ?? 12),
        }))
      );
    }
  }, [open, models]);

  const setRow = (id: string, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  async function save(r: Row) {
    const hp = r.horsepower.trim() === "" ? null : parseFloat(r.horsepower);
    const warranty = parseInt(r.warranty || "12", 10);
    if (hp !== null && (isNaN(hp) || hp < 0)) {
      toast.error("Invalid HP");
      return;
    }
    if (isNaN(warranty) || warranty < 0) {
      toast.error("Invalid warranty months");
      return;
    }
    setBusy(r.id);
    const res = await updateEngineModel({
      id: r.id,
      brand: r.brand,
      model: r.model,
      horsepower: hp,
      stroke: r.stroke || null,
      default_warranty_months: warranty,
    });
    setBusy(null);
    if (res.ok) toast.success(`${r.brand} ${r.model} updated`);
    else toast.error(res.error);
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Engine models</DialogTitle>
            <DialogDescription>
              Type definitions, not stock — fix a typo or retire a discontinued
              model here. New models are created on a supplier receiving.
            </DialogDescription>
          </DialogHeader>
          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No engine models yet — they&apos;re created on a receiving.
            </p>
          ) : (
            <div className="thin-scrollbar max-h-[55vh] overflow-auto">
              <div className="grid grid-cols-[8rem_minmax(10rem,1fr)_5rem_7.5rem_5rem_auto] items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">Brand</span>
                <span className="text-xs font-medium text-muted-foreground">Model</span>
                <span className="text-xs font-medium text-muted-foreground">HP</span>
                <span className="text-xs font-medium text-muted-foreground">Stroke</span>
                <span className="text-xs font-medium text-muted-foreground">Warranty</span>
                <span />
                {rows.map((r) => (
                  <React.Fragment key={r.id}>
                    <Input
                      value={r.brand}
                      onChange={(e) => setRow(r.id, { brand: e.target.value })}
                      aria-label="Brand"
                    />
                    <Input
                      value={r.model}
                      onChange={(e) => setRow(r.id, { model: e.target.value })}
                      aria-label="Model"
                    />
                    <Input
                      inputMode="decimal"
                      value={r.horsepower}
                      onChange={(e) => setRow(r.id, { horsepower: e.target.value })}
                      aria-label="Horsepower"
                    />
                    <Select
                      value={r.stroke}
                      onValueChange={(v) => setRow(r.id, { stroke: v as Row["stroke"] })}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="—" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="2-stroke">2-stroke</SelectItem>
                        <SelectItem value="4-stroke">4-stroke</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      inputMode="numeric"
                      value={r.warranty}
                      onChange={(e) => setRow(r.id, { warranty: e.target.value })}
                      aria-label="Default warranty months"
                    />
                    <div className="flex">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Save ${r.brand} ${r.model}`}
                        disabled={busy !== null}
                        onClick={() => save(r)}
                      >
                        {busy === r.id ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Save className="size-4" />
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Retire ${r.brand} ${r.model}`}
                        title="Retire (existing engines keep it)"
                        onClick={() => setRetiring(r)}
                      >
                        <Archive className="size-4" />
                      </Button>
                    </div>
                  </React.Fragment>
                ))}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={retiring !== null}
        onOpenChange={(o) => !o && setRetiring(null)}
        title={`Retire ${retiring?.brand} ${retiring?.model}?`}
        description="It disappears from pickers and receiving. Existing engines and their history keep the model."
        confirmLabel="Retire"
        destructive
        onConfirm={async () => {
          if (!retiring) return;
          const res = await softDeleteEngineModel(retiring.id);
          if (res.ok) {
            toast.success(`${retiring.brand} ${retiring.model} retired`);
            setRows((rs) => rs.filter((r) => r.id !== retiring.id));
          } else toast.error(res.error);
        }}
      />
    </>
  );
}

