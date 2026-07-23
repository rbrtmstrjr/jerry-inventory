"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { type ColumnDef } from "@tanstack/react-table";
import { ClipboardList, Loader2, Plus, Printer } from "lucide-react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTable } from "@/components/data-table/data-table";
import { createCountSnapshot } from "./actions";

export interface CountListRow {
  id: string;
  snapshot_date: string;
  note: string | null;
  shop_name: string;
  total_lines: number;
  counted_lines: number;
  variance_lines: number;
  sent_lines: number;
}

export function CountsList({
  snapshots,
  shops,
}: {
  snapshots: CountListRow[];
  shops: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [shopId, setShopId] = React.useState("");
  const [note, setNote] = React.useState("");
  const [blind, setBlind] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  async function onCreate() {
    if (!shopId) {
      toast.error("Pick a shop");
      return;
    }
    setBusy(true);
    const res = await createCountSnapshot({ shop_id: shopId, note: note || undefined });
    setBusy(false);
    if (res.ok && res.id) {
      toast.success("Count sheet created — expected quantities frozen");
      window.open(`/counts/${res.id}/sheet${blind ? "?blind=1" : ""}`, "_blank");
      router.push(`/counts/${res.id}`);
    } else if (!res.ok) {
      toast.error(res.error);
    }
  }

  const columns: ColumnDef<CountListRow>[] = [
    {
      accessorKey: "snapshot_date",
      header: "Date",
      cell: ({ getValue }) => format(new Date(getValue<string>()), "MMM d, yyyy"),
    },
    { accessorKey: "shop_name", header: "Shop" },
    {
      id: "progress",
      header: "Counted",
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.counted_lines}/{row.original.total_lines}
        </span>
      ),
    },
    {
      id: "variances",
      header: "Variances",
      cell: ({ row }) =>
        row.original.counted_lines === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : row.original.variance_lines === 0 ? (
          <Badge variant="secondary">All match</Badge>
        ) : (
          <Badge variant="destructive">{row.original.variance_lines} flagged</Badge>
        ),
    },
    {
      id: "sent",
      header: "Sent to queue",
      cell: ({ row }) =>
        row.original.sent_lines > 0 ? (
          <Badge>{row.original.sent_lines} losses</Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      accessorKey: "note",
      header: "Note",
      cell: ({ getValue }) => (
        <span className="line-clamp-1 max-w-xs text-muted-foreground">
          {getValue<string | null>() ?? "—"}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/counts/${row.original.id}`}>Open</Link>
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/counts/${row.original.id}/sheet?blind=1`} target="_blank">
              <Printer className="size-4" /> Sheet
            </Link>
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardList className="size-4" /> New count sheet
          </CardTitle>
          <CardDescription>
            Creates a snapshot of the shop&apos;s stock right now, so the count
            compares against a frozen figure.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1">
            <Label className="text-xs">Shop</Label>
            <Select value={shopId} onValueChange={setShopId}>
              <SelectTrigger className="w-52">
                <SelectValue placeholder="Pick a shop" />
              </SelectTrigger>
              <SelectContent>
                {shops.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="cnt-note" className="text-xs">Note (optional)</Label>
            <Input
              id="cnt-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. July month-end"
              className="w-56"
            />
          </div>
          <Label className="flex cursor-pointer items-center gap-2 pb-2 text-sm">
            <Checkbox checked={blind} onCheckedChange={(v) => setBlind(v === true)} />
            Blind count sheet (hide expected)
          </Label>
          <Button onClick={onCreate} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Create &amp; print
          </Button>
        </CardContent>
      </Card>

      <DataTable
        columns={columns}
        data={snapshots}
        searchPlaceholder="Search counts…"
        emptyMessage="No count sheets yet."
      />
    </div>
  );
}
