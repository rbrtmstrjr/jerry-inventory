"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Loader2, Plus, Printer, Send, Trash2, Undo2, X } from "lucide-react";
import { toast } from "sonner";

import type { ShopEngineRow, ShopStockRow } from "@/lib/db-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { requestReturn, cancelReturn } from "../actions";

export type ShopReturn = {
  id: string;
  reason: string | null;
  status: "requested" | "approved" | "rejected" | "cancelled";
  review_note: string | null;
  created_at: string;
  line_count: number;
  qty_total: number;
};
export type ShopReturnLine = {
  id: string;
  return_id: string;
  part_id: string | null;
  engine_id: string | null;
  name: string;
  unit: string;
  serial_number: string | null;
  qty: number;
  qty_damaged: number;
};

type PartLine = {
  key: string;
  part_id: string;
  name: string;
  unit: string;
  available: number;
  good: string;
  damaged: string;
};
type EngineLine = {
  key: string;
  engine_id: string;
  label: string;
  serial: string;
  condition: "good" | "damaged";
};

const STATUS: Record<ShopReturn["status"], { label: string; variant: "secondary" | "default" | "outline" | "destructive" }> = {
  requested: { label: "Waiting for Admin", variant: "secondary" },
  approved: { label: "Approved", variant: "default" },
  rejected: { label: "Rejected", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "outline" },
};

/**
 * Shop → Admin returns. The shop requests a return of its own stock; Admin
 * approves (good → master, damaged → a loss at cost) or rejects. Mirrors the
 * transfer request flow — no stock moves until Admin approves.
 */
export function ShopReturnsPanel({
  stock,
  engines,
  returns,
  lines,
}: {
  stock: ShopStockRow[];
  engines: ShopEngineRow[];
  returns: ShopReturn[];
  lines: ShopReturnLine[];
}) {
  const router = useRouter();
  const [reason, setReason] = React.useState("");
  const [parts, setParts] = React.useState<PartLine[]>([]);
  const [enginesPicked, setEnginesPicked] = React.useState<EngineLine[]>([]);
  const [pickPart, setPickPart] = React.useState("");
  const [pickEngine, setPickEngine] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const linesByReturn = React.useMemo(() => {
    const m = new Map<string, ShopReturnLine[]>();
    for (const l of lines) (m.get(l.return_id) ?? m.set(l.return_id, []).get(l.return_id)!).push(l);
    return m;
  }, [lines]);

  function addPart() {
    const s = stock.find((x) => x.part_id === pickPart);
    if (!s) return;
    if (parts.some((p) => p.part_id === s.part_id)) {
      toast.info("That item is already on the return");
      return;
    }
    setParts((p) => [
      ...p,
      { key: s.part_id, part_id: s.part_id, name: s.name, unit: s.unit, available: s.qty, good: "1", damaged: "0" },
    ]);
    setPickPart("");
  }
  // clamp so good + damaged can never exceed what's on hand (empty stays empty)
  function setQtyField(key: string, field: "good" | "damaged", value: string) {
    const digits = value.replace(/\D/g, "");
    setParts((ps) =>
      ps.map((x) => {
        if (x.key !== key) return x;
        if (digits === "") return { ...x, [field]: "" };
        const other = parseInt((field === "good" ? x.damaged : x.good) || "0", 10) || 0;
        const capped = Math.min(parseInt(digits, 10), Math.max(0, x.available - other));
        return { ...x, [field]: String(capped) };
      })
    );
  }

  function addEngine() {
    const e = engines.find((x) => x.engine_id === pickEngine);
    if (!e) return;
    if (enginesPicked.some((x) => x.engine_id === e.engine_id)) return;
    setEnginesPicked((x) => [
      ...x,
      {
        key: e.engine_id,
        engine_id: e.engine_id,
        label: `${e.brand} ${e.model}`,
        serial: e.serial_number,
        condition: "good",
      },
    ]);
    setPickEngine("");
  }

  async function onSubmit() {
    const partsPayload = parts
      .map((p) => ({
        part_id: p.part_id,
        qty_good: parseInt(p.good || "0", 10) || 0,
        qty_damaged: parseInt(p.damaged || "0", 10) || 0,
      }))
      .filter((p) => p.qty_good + p.qty_damaged > 0);
    for (const p of parts) {
      const g = parseInt(p.good || "0", 10) || 0;
      const d = parseInt(p.damaged || "0", 10) || 0;
      if (g + d > p.available) {
        toast.error(`${p.name}: only ${p.available} ${p.unit} on hand`);
        return;
      }
    }
    if (partsPayload.length + enginesPicked.length === 0) {
      toast.error("Add at least one item to return");
      return;
    }
    setBusy(true);
    const res = await requestReturn({
      reason: reason.trim() || null,
      parts: partsPayload,
      engines: enginesPicked.map((e) => ({ engine_id: e.engine_id, condition: e.condition })),
    });
    setBusy(false);
    if (res.ok) {
      toast.success("Return requested — waiting for Admin to approve");
      setReason("");
      setParts([]);
      setEnginesPicked([]);
      router.refresh();
    } else toast.error(res.error);
  }

  async function onCancel(id: string) {
    const res = await cancelReturn(id);
    if (res.ok) {
      toast.success("Return request cancelled");
      router.refresh();
    } else toast.error(res.error);
  }

  const availPart = stock.filter((s) => s.qty > 0 && !parts.some((p) => p.part_id === s.part_id));
  const availEngine = engines.filter((e) => !enginesPicked.some((x) => x.engine_id === e.engine_id));
  const hasItems =
    enginesPicked.length > 0 ||
    parts.some((p) => (parseInt(p.good || "0", 10) || 0) + (parseInt(p.damaged || "0", 10) || 0) > 0);

  return (
    <div className="flex flex-col gap-5">
      {/* Request form */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Undo2 className="size-4" /> Return to Admin
          </CardTitle>
          <CardDescription>
            Send your stock back to master — slow-movers or damaged items. Admin
            approves before anything moves.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="ret-reason">Reason (optional)</Label>
            <Input
              id="ret-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. slow-mover, damaged"
            />
          </div>

          {/* Parts */}
          <div className="grid gap-2">
            <Label>Parts</Label>
            <div className="flex flex-wrap items-end gap-2">
              <Select value={pickPart} onValueChange={setPickPart}>
                <SelectTrigger className="w-64">
                  <SelectValue placeholder="Pick an item…" />
                </SelectTrigger>
                <SelectContent>
                  {availPart.map((s) => (
                    <SelectItem key={s.part_id} value={s.part_id}>
                      {s.name} · {s.qty} {s.unit}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="button" variant="outline" size="sm" onClick={addPart} disabled={!pickPart}>
                <Plus className="size-4" /> Add
              </Button>
            </div>
            {parts.map((p) => (
              <div key={p.key} className="flex flex-wrap items-end gap-3 rounded-md border px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{p.name}</div>
                  <div className="text-xs text-muted-foreground">{p.available} {p.unit} on hand</div>
                </div>
                <div className="grid gap-1">
                  <Label className="text-xs">Good</Label>
                  <Input
                    className="w-20 tabular-nums"
                    inputMode="numeric"
                    max={p.available}
                    value={p.good}
                    onChange={(e) => setQtyField(p.key, "good", e.target.value)}
                  />
                </div>
                <div className="grid gap-1">
                  <Label className="text-xs">Damaged</Label>
                  <Input
                    className="w-20 tabular-nums"
                    inputMode="numeric"
                    max={p.available}
                    value={p.damaged}
                    onChange={(e) => setQtyField(p.key, "damaged", e.target.value)}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove"
                  onClick={() => setParts((ps) => ps.filter((x) => x.key !== p.key))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>

          {/* Engines */}
          <div className="grid gap-2">
            <Label>Engines</Label>
            <div className="flex flex-wrap items-end gap-2">
              <Select value={pickEngine} onValueChange={setPickEngine}>
                <SelectTrigger className="w-64">
                  <SelectValue placeholder="Pick an engine…" />
                </SelectTrigger>
                <SelectContent>
                  {availEngine.map((e) => (
                    <SelectItem key={e.engine_id} value={e.engine_id}>
                      {e.brand} {e.model} · SN {e.serial_number}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="button" variant="outline" size="sm" onClick={addEngine} disabled={!pickEngine}>
                <Plus className="size-4" /> Add
              </Button>
            </div>
            {enginesPicked.map((e) => (
              <div key={e.key} className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{e.label}</div>
                  <div className="font-mono text-xs text-muted-foreground">SN {e.serial}</div>
                </div>
                <Select
                  value={e.condition}
                  onValueChange={(v) =>
                    setEnginesPicked((xs) => xs.map((x) => (x.key === e.key ? { ...x, condition: v as "good" | "damaged" } : x)))
                  }
                >
                  <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="good">Good</SelectItem>
                    <SelectItem value="damaged">Damaged</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove"
                  onClick={() => setEnginesPicked((xs) => xs.filter((x) => x.key !== e.key))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>

          <Button onClick={onSubmit} disabled={busy || !hasItems} className="self-start">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Request return
          </Button>
        </CardContent>
      </Card>

      {/* My return requests */}
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">My returns</h2>
        {returns.length === 0 ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            No returns yet.
          </p>
        ) : (
          returns.map((r) => (
            <Card key={r.id} className={r.status === "rejected" ? "border-destructive/40" : ""}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-base">
                    {r.line_count} item{r.line_count === 1 ? "" : "s"} · {r.qty_total} unit
                    {r.qty_total === 1 ? "" : "s"}
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge variant={STATUS[r.status].variant}>{STATUS[r.status].label}</Badge>
                    {r.status !== "cancelled" && (
                      <Button variant="outline" size="sm" asChild>
                        <a href={`/return/${r.id}/slip`} target="_blank" rel="noopener noreferrer">
                          <Printer className="size-3.5" /> Print slip
                        </a>
                      </Button>
                    )}
                    {r.status === "requested" && (
                      <Button variant="outline" size="sm" onClick={() => onCancel(r.id)}>
                        <X className="size-3.5" /> Cancel
                      </Button>
                    )}
                  </div>
                </div>
                <CardDescription>
                  {format(new Date(r.created_at), "MMM d, yyyy h:mm a")}
                  {r.reason ? ` · ${r.reason}` : ""}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-1 text-sm">
                {(linesByReturn.get(r.id) ?? []).map((l) => (
                  <div key={l.id} className="flex justify-between gap-2">
                    <span className="truncate">
                      {l.name}
                      {l.serial_number && (
                        <span className="ml-1 font-mono text-xs text-muted-foreground">
                          SN {l.serial_number}
                        </span>
                      )}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      × {l.qty} {l.engine_id ? "" : l.unit}
                      {l.qty_damaged > 0 && (
                        <span className="ml-1 text-warning-foreground">({l.qty_damaged} damaged)</span>
                      )}
                    </span>
                  </div>
                ))}
                {r.status === "rejected" && r.review_note && (
                  <p className="mt-1 rounded-md bg-destructive/5 p-2 text-xs text-destructive">
                    Admin: “{r.review_note}”
                  </p>
                )}
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
