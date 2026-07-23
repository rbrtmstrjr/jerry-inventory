"use client";

import * as React from "react";
import Link from "next/link";
import { format } from "date-fns";
import { Loader2, Printer, Save, Search, Send } from "lucide-react";
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

// A count sheet can hold hundreds of lines; reveal in batches so the first
// paint is instant and scrolling adds more.
const COUNT_PAGE = 60;

// One count row, memoized so typing in a single input re-renders only that row
// — not the whole (potentially 400-line) sheet.
const CountRow = React.memo(function CountRow({
  line,
  value,
  reason,
  onCountChange,
  onReasonChange,
}: {
  line: CountLine;
  value: string;
  reason: string;
  onCountChange: (id: string, val: string) => void;
  onReasonChange: (id: string, val: string) => void;
}) {
  const n = value === "" ? NaN : parseInt(value, 10);
  const v = isNaN(n) ? null : n - line.expected_qty;
  return (
    <TableRow className={v !== null && v < 0 ? "bg-destructive/5" : undefined}>
      <TableCell>
        <div className="font-medium">{line.part_name}</div>
        {line.barcode && (
          <div className="font-mono text-xs text-muted-foreground">
            {line.barcode}
          </div>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {line.expected_qty} {line.unit}
      </TableCell>
      <TableCell>
        <Input
          inputMode="numeric"
          value={value}
          onChange={(e) => onCountChange(line.id, e.target.value)}
          placeholder="—"
          disabled={line.sent}
          aria-label={`Counted quantity for ${line.part_name}`}
        />
      </TableCell>
      <TableCell className="text-right">
        {line.sent ? (
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
        {v !== null && v < 0 && !line.sent && (
          <Select
            value={reason || "nawala"}
            onValueChange={(val) => onReasonChange(line.id, val)}
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
});

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
  const [query, setQuery] = React.useState("");
  const [visibleCount, setVisibleCount] = React.useState(COUNT_PAGE);
  const sentinelRef = React.useRef<HTMLDivElement | null>(null);

  // Stable callbacks so a memoized CountRow only re-renders when its own value
  // changes — typing one count doesn't touch the other rows.
  const onCountChange = React.useCallback((id: string, val: string) => {
    setCounts((c) => ({ ...c, [id]: val }));
  }, []);
  const onReasonChange = React.useCallback((id: string, val: string) => {
    setReasons((r) => ({ ...r, [id]: val }));
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? lines.filter(
        (l) =>
          l.part_name.toLowerCase().includes(q) ||
          (l.barcode ?? "").toLowerCase().includes(q)
      )
    : lines;
  // visible always takes the first N of whatever's filtered, so searching just
  // shows the first matches and the sentinel reveals more — no reset needed.
  const visible = filtered.slice(0, visibleCount);

  // Reveal the next batch as the sentinel scrolls into view.
  React.useEffect(() => {
    const el = sentinelRef.current;
    if (!el || visibleCount >= filtered.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((n) => Math.min(n + COUNT_PAGE, filtered.length));
        }
      },
      { rootMargin: "400px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visibleCount, filtered.length]);

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

      <div className="relative w-full max-w-xs">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find an item…"
          className="pl-8"
          aria-label="Find an item to count"
        />
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead className="text-right">Expected</TableHead>
              <TableHead className="w-32">Counted</TableHead>
              <TableHead className="text-right">Variance</TableHead>
              <TableHead className="w-44">Reason (if short)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((l) => (
              <CountRow
                key={l.id}
                line={l}
                value={counts[l.id] ?? ""}
                reason={reasons[l.id] ?? ""}
                onCountChange={onCountChange}
                onReasonChange={onReasonChange}
              />
            ))}
            {filtered.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={5}
                  className="py-10 text-center text-sm text-muted-foreground"
                >
                  Nothing matches “{query}”.
                </TableCell>
              </TableRow>
            )}
            {visibleCount < filtered.length && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="py-4">
                  <div
                    ref={sentinelRef}
                    className="text-center text-xs text-muted-foreground"
                  >
                    Loading more… ({visible.length} of {filtered.length})
                  </div>
                </TableCell>
              </TableRow>
            )}
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
