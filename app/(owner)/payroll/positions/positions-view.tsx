"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { Loader2, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { formatCentavos, parsePesosToCentavos } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { DataTable, SortableHeader } from "@/components/data-table/data-table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { softDeletePosition, upsertPosition } from "../actions";

export interface PositionRow {
  id: string;
  title: string;
  shop_id: string | null;
  shop_name: string | null;
  default_pay_rate: number | null;
  active: boolean;
  staff_count: number;
}

export function PositionsView({
  positions,
  shops,
}: {
  positions: PositionRow[];
  shops: { id: string; name: string }[];
}) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<PositionRow | null>(null);
  const [removing, setRemoving] = React.useState<PositionRow | null>(null);
  const [busy, setBusy] = React.useState(false);

  const [title, setTitle] = React.useState("");
  const [shopId, setShopId] = React.useState("global");
  const [rate, setRate] = React.useState("");
  const [active, setActive] = React.useState(true);

  function openDialog(p: PositionRow | null) {
    setEditing(p);
    setTitle(p?.title ?? "");
    setShopId(p?.shop_id ?? "global");
    setRate(p?.default_pay_rate != null ? (p.default_pay_rate / 100).toFixed(2) : "");
    setActive(p?.active ?? true);
    setDialogOpen(true);
  }

  async function onSave() {
    let rateCentavos: number | null = null;
    if (rate.trim() !== "") {
      rateCentavos = parsePesosToCentavos(rate);
      if (rateCentavos === null) {
        toast.error("Enter a valid ₱ rate (or leave it blank)");
        return;
      }
    }
    setBusy(true);
    const res = await upsertPosition({
      id: editing?.id,
      title,
      shop_id: shopId === "global" ? null : shopId,
      default_pay_rate: rateCentavos,
      active,
    });
    setBusy(false);
    if (res.ok) {
      toast.success(editing ? "Position updated" : "Position added");
      setDialogOpen(false);
    } else toast.error(res.error);
  }

  const columns: ColumnDef<PositionRow>[] = [
    {
      accessorKey: "title",
      header: ({ column }) => <SortableHeader column={column}>Title</SortableHeader>,
      cell: ({ row }) => (
        <span className="font-medium">{row.original.title}</span>
      ),
    },
    {
      accessorKey: "shop_name",
      header: "Scope",
      cell: ({ getValue }) =>
        getValue<string | null>() ?? <Badge variant="outline">All shops</Badge>,
    },
    {
      accessorKey: "default_pay_rate",
      header: "Default rate",
      cell: ({ getValue }) => {
        const v = getValue<number | null>();
        return v != null ? (
          <span className="tabular-nums">{formatCentavos(v)}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        );
      },
    },
    {
      accessorKey: "staff_count",
      header: "Staff",
      cell: ({ getValue }) => <span className="tabular-nums">{getValue<number>()}</span>,
    },
    {
      accessorKey: "active",
      header: "Status",
      cell: ({ getValue }) => (
        <Badge variant={getValue<boolean>() ? "secondary" : "destructive"}>
          {getValue<boolean>() ? "Active" : "Inactive"}
        </Badge>
      ),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Actions for ${row.original.title}`}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => openDialog(row.original)}>
              <Pencil className="size-4" /> Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setRemoving(row.original)}
            >
              <Trash2 className="size-4" /> Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <>
      <DataTable
        columns={columns}
        data={positions}
        searchPlaceholder="Search positions…"
        emptyMessage="No positions yet — add job titles like Shop Attendant, Cashier, Mechanic."
        toolbar={
          <Button onClick={() => openDialog(null)}>
            <Plus className="size-4" /> Add position
          </Button>
        }
      />

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Position" : "Add Position"}</DialogTitle>
            <DialogDescription>
              The default rate pre-fills when assigning staff — each person&apos;s
              rate can still be adjusted individually.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="pos-title">Title</Label>
              <Input
                id="pos-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Branch Manager"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid min-w-0 gap-2">
                <Label>Scope</Label>
                <Select value={shopId} onValueChange={setShopId}>
                  <SelectTrigger className="w-full max-w-full [&>span]:truncate">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="global">All shops</SelectItem>
                    {shops.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="pos-rate">Default rate ₱ (optional)</Label>
                <Input
                  id="pos-rate"
                  inputMode="decimal"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  placeholder="e.g. 450.00"
                />
              </div>
            </div>
            {editing && (
              <Label className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={active}
                  onCheckedChange={(v) => setActive(v === true)}
                />
                Active (inactive positions can&apos;t be assigned)
              </Label>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={onSave} disabled={busy || title.trim() === ""}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {editing ? "Save" : "Add position"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove “${removing?.title}”?`}
        description={
          removing?.staff_count
            ? `${removing.staff_count} staff currently hold this position — they keep it on their record, but it can't be assigned anymore.`
            : "It can no longer be assigned; history stays intact."
        }
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (!removing) return;
          const res = await softDeletePosition(removing.id);
          if (res.ok) toast.success(`${removing.title} removed`);
          else toast.error(res.error);
        }}
      />
    </>
  );
}
