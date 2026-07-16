"use client";

import * as React from "react";
import { format } from "date-fns";
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
import { Textarea } from "@/components/ui/textarea";
import { DataTable, SortableHeader } from "@/components/data-table/data-table";
import { DatePicker } from "@/components/date-picker";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { softDeleteStaff, upsertStaff } from "../actions";

export interface StaffRow {
  id: string;
  full_name: string;
  shop_id: string;
  shop_name: string;
  position_id: string | null;
  position: string | null;
  pay_type: "daily" | "monthly";
  pay_rate: number;
  date_hired: string | null;
  active: boolean;
  notes: string | null;
  sss_no: string | null;
  philhealth_no: string | null;
  pagibig_no: string | null;
  contributions_enabled: boolean;
}

export interface PositionOption {
  id: string;
  title: string;
  shop_id: string | null;
  default_pay_rate: number | null;
}

export function StaffView({
  staff,
  shops,
  positions,
}: {
  staff: StaffRow[];
  shops: { id: string; name: string }[];
  positions: PositionOption[];
}) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<StaffRow | null>(null);
  const [removing, setRemoving] = React.useState<StaffRow | null>(null);
  const [busy, setBusy] = React.useState(false);

  const [name, setName] = React.useState("");
  const [shopId, setShopId] = React.useState("");
  const [positionId, setPositionId] = React.useState("");
  const [payType, setPayType] = React.useState<"daily" | "monthly">("daily");
  const [rate, setRate] = React.useState("");
  const [hired, setHired] = React.useState("");
  const [active, setActive] = React.useState(true);
  const [notes, setNotes] = React.useState("");
  const [sssNo, setSssNo] = React.useState("");
  const [philhealthNo, setPhilhealthNo] = React.useState("");
  const [pagibigNo, setPagibigNo] = React.useState("");
  const [contributionsEnabled, setContributionsEnabled] = React.useState(true);

  function openDialog(s: StaffRow | null) {
    setEditing(s);
    setName(s?.full_name ?? "");
    setShopId(s?.shop_id ?? "");
    setPositionId(s?.position_id ?? "");
    setPayType(s?.pay_type ?? "daily");
    setRate(s ? (s.pay_rate / 100).toFixed(2) : "");
    setHired(s?.date_hired ?? "");
    setActive(s?.active ?? true);
    setNotes(s?.notes ?? "");
    setSssNo(s?.sss_no ?? "");
    setPhilhealthNo(s?.philhealth_no ?? "");
    setPagibigNo(s?.pagibig_no ?? "");
    setContributionsEnabled(s?.contributions_enabled ?? true);
    setDialogOpen(true);
  }

  // positions available for the chosen shop (global + shop-specific)
  const positionChoices = positions.filter(
    (p) => p.shop_id === null || p.shop_id === shopId
  );

  async function onSave() {
    const rateCentavos = parsePesosToCentavos(rate || "0");
    if (rateCentavos === null) {
      toast.error("Enter a valid ₱ rate");
      return;
    }
    setBusy(true);
    const res = await upsertStaff({
      id: editing?.id,
      full_name: name,
      shop_id: shopId,
      position_id: positionId || null,
      pay_type: payType,
      pay_rate: rateCentavos,
      date_hired: hired || null,
      active,
      notes: notes || null,
      sss_no: sssNo || null,
      philhealth_no: philhealthNo || null,
      pagibig_no: pagibigNo || null,
      contributions_enabled: contributionsEnabled,
    });
    setBusy(false);
    if (res.ok) {
      toast.success(editing ? "Staff updated" : "Staff added");
      setDialogOpen(false);
    } else toast.error(res.error);
  }

  const columns: ColumnDef<StaffRow>[] = [
    {
      accessorKey: "full_name",
      header: ({ column }) => <SortableHeader column={column}>Name</SortableHeader>,
      cell: ({ row }) => (
        <div className={!row.original.active ? "opacity-60" : undefined}>
          <div className="font-medium">{row.original.full_name}</div>
          <div className="text-xs text-muted-foreground">
            {row.original.position ?? "No position"}
          </div>
        </div>
      ),
    },
    { accessorKey: "shop_name", header: "Shop" },
    {
      accessorKey: "pay_rate",
      header: ({ column }) => <SortableHeader column={column}>Rate</SortableHeader>,
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatCentavos(row.original.pay_rate)}
          <span className="text-xs text-muted-foreground">
            {row.original.pay_type === "daily" ? "/day" : "/mo"}
          </span>
        </span>
      ),
    },
    {
      accessorKey: "date_hired",
      header: "Hired",
      cell: ({ getValue }) => {
        const v = getValue<string | null>();
        return v ? (
          format(new Date(v), "MMM d, yyyy")
        ) : (
          <span className="text-muted-foreground">—</span>
        );
      },
    },
    {
      id: "contributions",
      header: "Contributions",
      cell: ({ row }) =>
        row.original.contributions_enabled ? (
          <Badge variant="secondary">Enrolled</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">Not enrolled</span>
        ),
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
              aria-label={`Actions for ${row.original.full_name}`}
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
        data={staff}
        searchPlaceholder="Search staff…"
        emptyMessage="No staff yet — add the people you pay (they don't need app logins)."
        rowClassName={(s) => (!s.active ? "opacity-70" : undefined)}
        toolbar={
          <Button onClick={() => openDialog(null)}>
            <Plus className="size-4" /> Add staff
          </Button>
        }
      />

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Staff" : "Add Staff"}</DialogTitle>
            <DialogDescription>
              Payroll staff are separate from app logins — helpers and cashiers
              belong here even without an account.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="st-name">Full name</Label>
              <Input
                id="st-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Juan Dela Cruz"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid min-w-0 gap-2">
                <Label>Shop</Label>
                <Select
                  value={shopId}
                  onValueChange={(v) => {
                    setShopId(v);
                    setPositionId("");
                  }}
                >
                  <SelectTrigger className="w-full max-w-full [&>span]:truncate">
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
              <div className="grid min-w-0 gap-2">
                <Label>Position</Label>
                <Select
                  value={positionId}
                  onValueChange={(v) => {
                    setPositionId(v);
                    const pos = positions.find((p) => p.id === v);
                    if (pos?.default_pay_rate != null && !rate) {
                      setRate((pos.default_pay_rate / 100).toFixed(2));
                    }
                  }}
                  disabled={!shopId}
                >
                  <SelectTrigger className="w-full max-w-full [&>span]:truncate">
                    <SelectValue placeholder={shopId ? "Pick a position" : "Pick a shop first"} />
                  </SelectTrigger>
                  <SelectContent>
                    {positionChoices.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="grid min-w-0 gap-2">
                <Label>Pay type</Label>
                <Select
                  value={payType}
                  onValueChange={(v) => setPayType(v as "daily" | "monthly")}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily rate</SelectItem>
                    <SelectItem value="monthly">Monthly salary</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="st-rate">
                  {payType === "daily" ? "Rate ₱/day" : "Salary ₱/month"}
                </Label>
                <Input
                  id="st-rate"
                  inputMode="decimal"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="grid gap-2">
                <Label>Date hired</Label>
                <DatePicker value={hired} onChange={setHired} className="w-full" />
              </div>
            </div>
            {/* Government contributions — IDs + enrollment. The rates behind
                them are data (Settings → rate book), never entered here. */}
            <div className="grid gap-3 rounded-md border p-3">
              <div>
                <div className="text-sm font-medium">Government contributions</div>
                <p className="text-xs text-muted-foreground">
                  SSS · PhilHealth · Pag-IBIG. Amounts come from the rate book —
                  only the ID numbers and enrollment live here.
                </p>
              </div>
              <Label className="flex cursor-pointer items-center gap-2 text-sm font-normal">
                <Checkbox
                  checked={contributionsEnabled}
                  onCheckedChange={(v) => setContributionsEnabled(v === true)}
                />
                Enrolled — deduct contributions each pay period
              </Label>
              {!contributionsEnabled && (
                <p className="text-xs text-muted-foreground">
                  Not enrolled — this staff member contributes nothing and takes
                  home their full gross pay.
                </p>
              )}
              <div className="grid grid-cols-3 gap-3">
                <div className="grid min-w-0 gap-2">
                  <Label htmlFor="st-sss" className="text-xs">
                    SSS no.
                  </Label>
                  <Input
                    id="st-sss"
                    value={sssNo}
                    onChange={(e) => setSssNo(e.target.value)}
                    placeholder="34-1234567-8"
                  />
                </div>
                <div className="grid min-w-0 gap-2">
                  <Label htmlFor="st-philhealth" className="text-xs">
                    PhilHealth no.
                  </Label>
                  <Input
                    id="st-philhealth"
                    value={philhealthNo}
                    onChange={(e) => setPhilhealthNo(e.target.value)}
                    placeholder="12-345678901-2"
                  />
                </div>
                <div className="grid min-w-0 gap-2">
                  <Label htmlFor="st-pagibig" className="text-xs">
                    Pag-IBIG no.
                  </Label>
                  <Input
                    id="st-pagibig"
                    value={pagibigNo}
                    onChange={(e) => setPagibigNo(e.target.value)}
                    placeholder="1234-5678-9012"
                  />
                </div>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="st-notes">Notes (optional)</Label>
              <Textarea
                id="st-notes"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
            {editing && (
              <Label className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={active}
                  onCheckedChange={(v) => setActive(v === true)}
                />
                Active (inactive staff are skipped in new pay periods)
              </Label>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={onSave}
              disabled={busy || name.trim() === "" || !shopId}
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              {editing ? "Save" : "Add staff"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.full_name}?`}
        description="Their payroll history stays in the records; they just disappear from lists and future pay periods."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (!removing) return;
          const res = await softDeleteStaff(removing.id);
          if (res.ok) toast.success(`${removing.full_name} removed`);
          else toast.error(res.error);
        }}
      />
    </>
  );
}
