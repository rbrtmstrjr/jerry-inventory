"use client";

import * as React from "react";
import Link from "next/link";
import { format } from "date-fns";
import { Loader2, Printer, Save, Send } from "lucide-react";
import { toast } from "sonner";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { recordCountShortages, saveCount } from "../actions";

export interface CountLine {
  id: string;
  part_name: string;
  unit: string;
  barcode: string | null;
  expected_qty: number;
  counted_qty: number | null;
  sent: boolean;
}

const REASONS = [
  { value: "nawala", label: "Nawala (missing)" },
  { value: "nasira", label: "Nasira (damaged)" },
  { value: "expired", label: "Expired" },
  { value: "correction", label: "Correction" },
] as const;

export function CountEntry({
  snapshotId,
  shopName,
  snapshotDate,
  note,
  lines,
}: {
  snapshotId: string;
  shopName: string;
  snapshotDate: string;
  note: string | null;
  lines: CountLine[];
}) {
  const [counts, setCounts] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(
      lines.map((l) => [l.id, l.counted_qty === null ? "" : String(l.counted_qty)])
    )
  );
  const [reasons, setReasons] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [confirmSend, setConfirmSend] = React.useState(false);

  function varianceOf(l: CountLine): number | null {
    const raw = counts[l.id];
    if (raw === "" || raw === undefined) return null;
    const n = parseInt(raw, 10);
    if (isNaN(n)) return null;
    return n - l.expected_qty;
  }

  const countedLines = lines.filter((l) => varianceOf(l) !== null);
  const shortages = lines.filter((l) => {
    const v = varianceOf(l);
    return v !== null && v < 0 && !l.sent;
  });
  const overages = lines.filter((l) => (varianceOf(l) ?? 0) > 0);

  async function onSave() {
    const payload = [];
    for (const l of lines) {
      const raw = counts[l.id] ?? "";
      if (raw === "") {
        payload.push({ line_id: l.id, counted_qty: null });
        continue;
      }
      const n = parseInt(raw, 10);
      if (isNaN(n) || n < 0) {
        toast.error(`${l.part_name}: invalid count`);
        return;
      }
      payload.push({ line_id: l.id, counted_qty: n });
    }
    setSaving(true);
    const res = await saveCount({ snapshot_id: snapshotId, lines: payload });
    setSaving(false);
    if (res.ok) toast.success("Counts saved");
    else toast.error(res.error);
  }

  async function onSendShortages() {
    if (shortages.length === 0) return;

    // persist counts first so the DB validates against what's on screen
    setSending(true);
    const saveRes = await saveCount({
      snapshot_id: snapshotId,
      lines: lines.map((l) => ({
        line_id: l.id,
        counted_qty: counts[l.id] === "" ? null : parseInt(counts[l.id], 10),
      })),
    });
    if (!saveRes.ok) {
      setSending(false);
      toast.error(saveRes.error);
      return;
    }
    const res = await recordCountShortages({
      snapshot_id: snapshotId,
      lines: shortages.map((l) => ({
        line_id: l.id,
        reason: (reasons[l.id] ?? "nawala") as "nawala",
      })),
    });
    setSending(false);
    if (res.ok) {
      toast.success(`${res.created} loss(es) sent to the approval queue`);
    } else {
      toast.error(res.error);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Count — {shopName}
          </h1>
          <p className="text-sm text-muted-foreground">
            Snapshot {format(new Date(snapshotDate), "MMMM d, yyyy")}
            {note && ` · ${note}`} · counted {countedLines.length}/{lines.length}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link href={`/counts/${snapshotId}/sheet?blind=1`} target="_blank">
              <Printer className="size-4" /> Print sheet
            </Link>
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save counts
          </Button>
        </div>
      </div>

      {(shortages.length > 0 || overages.length > 0) && (
        <Card className="border-warning">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              Variances: {shortages.length} shortage(s), {overages.length} overage(s)
            </CardTitle>
            <CardDescription>
              Shortages become reason-coded losses in the normal approval queue.
              Overages usually mean a miscount or an unrecorded return — recheck
              before approving anything.
            </CardDescription>
          </CardHeader>
          {shortages.length > 0 && (
            <CardContent>
              <Button onClick={() => setConfirmSend(true)} disabled={sending}>
                {sending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Send className="size-4" />
                )}
                Send {shortages.length} shortage(s) to approval queue
              </Button>
            </CardContent>
          )}
        </Card>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead className="text-right">Expected</TableHead>
              <TableHead className="w-32">Counted</TableHead>
              <TableHead className="text-right">Variance</TableHead>
              <TableHead className="w-44">Reason (if short)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => {
              const v = varianceOf(l);
              return (
                <TableRow
                  key={l.id}
                  className={v !== null && v < 0 ? "bg-destructive/5" : undefined}
                >
                  <TableCell>
                    <div className="font-medium">{l.part_name}</div>
                    {l.barcode && (
                      <div className="font-mono text-xs text-muted-foreground">
                        {l.barcode}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {l.expected_qty} {l.unit}
                  </TableCell>
                  <TableCell>
                    <Input
                      inputMode="numeric"
                      value={counts[l.id] ?? ""}
                      onChange={(e) =>
                        setCounts((c) => ({ ...c, [l.id]: e.target.value }))
                      }
                      placeholder="—"
                      disabled={l.sent}
                      aria-label={`Counted quantity for ${l.part_name}`}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    {l.sent ? (
                      <Badge>Sent to queue</Badge>
                    ) : v === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : v === 0 ? (
                      <Badge variant="secondary">Match</Badge>
                    ) : v < 0 ? (
                      <Badge variant="destructive">{v}</Badge>
                    ) : (
                      <Badge variant="outline">+{v}</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {v !== null && v < 0 && !l.sent && (
                      <Select
                        value={reasons[l.id] ?? "nawala"}
                        onValueChange={(val) =>
                          setReasons((r) => ({ ...r, [l.id]: val }))
                        }
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {REASONS.map((r) => (
                            <SelectItem key={r.value} value={r.value}>
                              {r.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <ConfirmDialog
        open={confirmSend}
        onOpenChange={setConfirmSend}
        title={`Send ${shortages.length} shortage(s) to the approval queue?`}
        description="Each shortage becomes a reason-coded loss, pending your approval — the same flow as any shop-recorded loss."
        confirmLabel="Send to queue"
        onConfirm={onSendShortages}
      />
    </div>
  );
}
