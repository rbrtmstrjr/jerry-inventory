"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { formatQty, parseQty, sanitizeQtyInput } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { correctMasterStock } from "./actions";

export interface CorrectablePart {
  id: string;
  name: string;
  unit: string;
  master_qty: number;
}

/** 0132: set master to the ACTUAL quantity. The delta is written as a
 *  `correction` movement, so the ledger keeps explaining the shelf. */
export function CorrectStockDialog({
  part,
  onOpenChange,
}: {
  part: CorrectablePart | null;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [raw, setRaw] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (part) {
      setRaw(formatQty(part.master_qty));
      setReason("");
    }
  }, [part]);

  // Every product allows a tenth here; fn_assert_qty is the single authority
  // that refuses a whole-unit product, by name, on save.
  const parsed = parseQty(raw, { allowFractional: true, allowZero: true });
  const delta = parsed === null || !part ? null : parsed - part.master_qty;
  const canSave =
    !busy && parsed !== null && delta !== null && delta !== 0 && reason.trim() !== "";

  async function onSubmit() {
    if (!part || parsed === null) return;
    setBusy(true);
    const res = await correctMasterStock({
      part_id: part.id, new_qty: parsed, reason: reason.trim(),
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(`${part.name} corrected to ${formatQty(parsed)} ${part.unit}`);
    onOpenChange(false);
    router.refresh();
  }

  return (
    <Dialog open={!!part} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Correct stock</DialogTitle>
          <DialogDescription>
            Set master to what is actually there. This does not change any
            shop&apos;s stock, and it is not recorded as a loss.
          </DialogDescription>
        </DialogHeader>

        {part && (
          <div className="flex flex-col gap-4">
            <div className="text-sm">
              <div className="font-medium">{part.name}</div>
              <div className="text-muted-foreground">
                System says {formatQty(part.master_qty)} {part.unit}
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="actual-qty">Actual quantity</Label>
              <Input
                id="actual-qty"
                inputMode="decimal"
                value={raw}
                onChange={(e) => setRaw(sanitizeQtyInput(e.target.value))}
                aria-label="Actual quantity"
              />
              {parsed !== null && delta !== null && delta !== 0 && (
                <p className="text-xs text-muted-foreground">
                  {formatQty(part.master_qty)} → {formatQty(parsed)} {part.unit}
                  {" · "}
                  {delta > 0 ? "+" : ""}
                  {formatQty(delta)} {part.unit}
                </p>
              )}
              {delta === 0 && (
                <p className="text-xs text-muted-foreground">
                  That is already the recorded quantity.
                </p>
              )}
              {parsed === null && raw.trim() !== "" && (
                // Never refuse silently — a greyed-out Save with no message
                // reads as acceptance.
                <p className="text-xs text-muted-foreground">
                  Enter a quantity with at most one decimal, e.g. 0.5 or 2.3.
                </p>
              )}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="correction-reason">Reason</Label>
              <Textarea
                id="correction-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. over-encoded at receiving"
                maxLength={300}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={!canSave}>
            {busy && <Loader2 className="size-4 animate-spin" />} Correct stock
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
