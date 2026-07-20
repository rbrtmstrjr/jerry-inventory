"use client";

import * as React from "react";
import { AlertTriangle, GitMerge, Loader2 } from "lucide-react";
import { toast } from "sonner";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { checkPartMergeable, mergeParts } from "./actions";

export interface MergePart {
  id: string;
  name: string;
  sku: string | null;
}

type Eligibility = { ok: true } | { ok: false; reason: string } | undefined;

/**
 * Fold duplicate parts into one survivor. Catalog identity only — the merge
 * moves no stock and writes no ledger row (fn_merge_parts). A source that
 * still holds stock / transit / open lines is shown blocked and can't be
 * selected. Reachable from Master Inventory and prefilled from the Price
 * Comparison duplicate nudge.
 */
export function MergeDuplicatesDialog({
  open,
  parts,
  prefill,
  onClose,
}: {
  open: boolean;
  parts: MergePart[];
  prefill?: { targetId: string; sourceIds: string[] } | null;
  onClose: () => void;
}) {
  const [targetId, setTargetId] = React.useState("");
  const [sourceIds, setSourceIds] = React.useState<Set<string>>(new Set());
  const [note, setNote] = React.useState("");
  const [elig, setElig] = React.useState<Record<string, Eligibility>>({});
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setTargetId(prefill?.targetId ?? "");
    setSourceIds(new Set(prefill?.sourceIds ?? []));
    setNote("");
    setElig({});
  }, [open, prefill]);

  // check each newly-selected source (skip the target)
  React.useEffect(() => {
    let cancelled = false;
    for (const id of sourceIds) {
      if (id === targetId || elig[id] !== undefined) continue;
      checkPartMergeable(id).then((res) => {
        if (!cancelled) setElig((e) => ({ ...e, [id]: res }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [sourceIds, targetId, elig]);

  const byId = React.useMemo(() => new Map(parts.map((p) => [p.id, p])), [parts]);
  const target = byId.get(targetId);

  function toggleSource(id: string, on: boolean) {
    setSourceIds((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const selected = [...sourceIds].filter((id) => id !== targetId);
  const blocked = selected.filter((id) => elig[id] && elig[id]!.ok === false);
  const ready = !!targetId && selected.length > 0 && blocked.length === 0
    && selected.every((id) => elig[id]?.ok === true);

  async function run() {
    if (!ready) return;
    setBusy(true);
    let ok = 0;
    for (const id of selected) {
      const res = await mergeParts(id, targetId, note || null);
      if (res.ok) ok++;
      else toast.error(`${byId.get(id)?.name ?? "Part"}: ${res.error}`);
    }
    setBusy(false);
    if (ok > 0) {
      toast.success(`Merged ${ok} duplicate${ok === 1 ? "" : "s"} into ${target?.name}`);
      onClose();
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Merge duplicate products</DialogTitle>
          <DialogDescription>
            Fold duplicates into one surviving product you can buy from either
            supplier. Pricing history and quotes roll up to the survivor;
            fitments carry over; the duplicates are retired. No stock moves — a
            duplicate that still holds stock must be zeroed first.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label>Keep (survivor)</Label>
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger className="w-full max-w-full [&>span]:truncate">
                <SelectValue placeholder="Pick the product to keep" />
              </SelectTrigger>
              <SelectContent>
                {parts.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                    {p.sku ? ` · ${p.sku}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {targetId && (
            <div className="grid gap-2">
              <Label>Merge these into it (retired)</Label>
              <div className="thin-scrollbar flex max-h-56 flex-col gap-1 overflow-auto rounded-md border p-1">
                {parts
                  .filter((p) => p.id !== targetId)
                  .map((p) => {
                    const on = sourceIds.has(p.id);
                    const e = elig[p.id];
                    const isBlocked = on && e && e.ok === false;
                    return (
                      <label
                        key={p.id}
                        className="flex items-start gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/50"
                      >
                        <Checkbox
                          className="mt-0.5"
                          checked={on}
                          onCheckedChange={(v) => toggleSource(p.id, v === true)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">
                            {p.name}
                            {p.sku && (
                              <span className="text-muted-foreground"> · {p.sku}</span>
                            )}
                          </span>
                          {on && e === undefined && (
                            <span className="text-xs text-muted-foreground">checking…</span>
                          )}
                          {isBlocked && (
                            <span className="flex items-center gap-1 text-xs text-destructive">
                              <AlertTriangle className="size-3 shrink-0" />
                              {(e as { reason: string }).reason}
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  })}
              </div>
              {blocked.length > 0 && (
                <p className="text-xs text-destructive">
                  {blocked.length} selected duplicate{blocked.length === 1 ? "" : "s"} can&apos;t
                  be merged yet — clear the blocker above or unselect them.
                </p>
              )}
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor="merge-note">Note (optional)</Label>
            <Input
              id="merge-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. same carburetor, two suppliers"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={run} disabled={!ready || busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <GitMerge className="size-4" />}
            Merge {selected.length > 0 ? `${selected.length} ` : ""}into survivor
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
