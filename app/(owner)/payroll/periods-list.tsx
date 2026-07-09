"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { type ColumnDef } from "@tanstack/react-table";
import { ArrowRight, CalendarPlus, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { formatCentavos } from "@/lib/format";
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
import { DatePicker } from "@/components/date-picker";
import { createPayPeriod } from "./actions";

export interface PeriodRow {
  id: string;
  label: string;
  start_date: string;
  end_date: string;
  frequency: "weekly" | "semi_monthly" | "monthly";
  status: "open" | "finalized";
  entry_count: number;
  paid_count: number;
  total_net: number;
}

const FREQ_LABEL: Record<PeriodRow["frequency"], string> = {
  weekly: "Weekly",
  semi_monthly: "Semi-monthly",
  monthly: "Monthly",
};

export function PeriodsList({
  periods,
  activeStaffCount,
}: {
  periods: PeriodRow[];
  activeStaffCount: number;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [label, setLabel] = React.useState("");
  const [start, setStart] = React.useState("");
  const [end, setEnd] = React.useState("");
  const [frequency, setFrequency] =
    React.useState<PeriodRow["frequency"]>("semi_monthly");
  const [busy, setBusy] = React.useState(false);

  // suggest a label from the picked dates
  React.useEffect(() => {
    if (start && end && !label.trim()) {
      const s = new Date(start + "T00:00:00");
      const e = new Date(end + "T00:00:00");
      const sameMonth =
        s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();
      setLabel(
        sameMonth
          ? `${format(s, "MMM d")}–${format(e, "d, yyyy")}`
          : `${format(s, "MMM d")} – ${format(e, "MMM d, yyyy")}`
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end]);

  async function onCreate() {
    if (!start || !end) {
      toast.error("Pick the period dates");
      return;
    }
    setBusy(true);
    const res = await createPayPeriod({
      label: label.trim(),
      start_date: start,
      end_date: end,
      frequency,
    });
    setBusy(false);
    if (res.ok && res.id) {
      toast.success("Pay period created — enter days worked");
      setOpen(false);
      setLabel("");
      setStart("");
      setEnd("");
      router.push(`/payroll/${res.id}`);
    } else if (!res.ok) {
      toast.error(res.error);
    }
  }

  const columns: ColumnDef<PeriodRow>[] = [
    {
      accessorKey: "label",
      header: "Period",
      cell: ({ row }) => (
        <div>
          <div className="font-medium">{row.original.label}</div>
          <div className="text-xs text-muted-foreground">
            {format(new Date(row.original.start_date), "MMM d")} –{" "}
            {format(new Date(row.original.end_date), "MMM d, yyyy")} ·{" "}
            {FREQ_LABEL[row.original.frequency]}
          </div>
        </div>
      ),
    },
    {
      id: "staff",
      header: "Staff",
      cell: ({ row }) => (
        <span className="tabular-nums">{row.original.entry_count}</span>
      ),
    },
    {
      id: "paid",
      header: "Paid",
      cell: ({ row }) =>
        row.original.paid_count === row.original.entry_count &&
        row.original.entry_count > 0 ? (
          <Badge>All paid</Badge>
        ) : (
          <span className="tabular-nums text-muted-foreground">
            {row.original.paid_count}/{row.original.entry_count}
          </span>
        ),
    },
    {
      accessorKey: "total_net",
      header: "Total pay",
      cell: ({ getValue }) => (
        <span className="tabular-nums font-medium">
          {formatCentavos(getValue<number>())}
        </span>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ getValue }) =>
        getValue<string>() === "finalized" ? (
          <Badge variant="secondary">Finalized</Badge>
        ) : (
          <Badge variant="outline">Open</Badge>
        ),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/payroll/${row.original.id}`}>
            Open <ArrowRight className="size-4" />
          </Link>
        </Button>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <DataTable
        columns={columns}
        data={periods}
        searchPlaceholder="Search periods…"
        emptyMessage={
          activeStaffCount === 0
            ? "Add staff first (Staff tab), then create your first pay period."
            : "No pay periods yet — create the first one."
        }
        toolbar={
          <Button onClick={() => setOpen(true)} disabled={activeStaffCount === 0}>
            <CalendarPlus className="size-4" /> New pay period
          </Button>
        }
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New Pay Period</DialogTitle>
            <DialogDescription>
              Creates a draft payslip line for each of your {activeStaffCount}{" "}
              active staff.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Start</Label>
                <DatePicker value={start} onChange={setStart} className="w-full" />
              </div>
              <div className="grid gap-2">
                <Label>End</Label>
                <DatePicker value={end} onChange={setEnd} className="w-full" />
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Frequency (sets monthly-salary proration)</Label>
              <Select
                value={frequency}
                onValueChange={(v) => setFrequency(v as PeriodRow["frequency"])}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="semi_monthly">
                    Semi-monthly (salary ÷ 2)
                  </SelectItem>
                  <SelectItem value="monthly">Monthly (full salary)</SelectItem>
                  <SelectItem value="weekly">Weekly (salary ÷ 4)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pp-label">Label</Label>
              <Input
                id="pp-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Jul 1–15, 2026"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={onCreate} disabled={busy || label.trim() === ""}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Create period
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
