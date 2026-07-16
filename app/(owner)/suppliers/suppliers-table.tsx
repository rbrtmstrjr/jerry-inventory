"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import type { SupplierRow } from "@/lib/db-types";
import { cn } from "@/lib/utils";
import { formatCentavos, parsePesosToCentavos } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DataTable, SortableHeader } from "@/components/data-table/data-table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { softDeleteSupplier, upsertSupplier } from "../master-inventory/actions";

const formSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  contact: z.string().optional(),
  notes: z.string().optional(),
  /** blank = no limit */
  credit_limit: z
    .string()
    .refine((v) => v.trim() === "" || parsePesosToCentavos(v) !== null, "Enter a valid ₱ amount"),
  payment_terms_days: z
    .string()
    .refine(
      (v) => v.trim() === "" || (!isNaN(Number(v)) && Number(v) >= 0 && Number(v) <= 365),
      "0–365 days"
    ),
  terms_note: z.string().optional(),
});
type FormValues = z.infer<typeof formSchema>;

export function SuppliersTable({ suppliers }: { suppliers: SupplierRow[] }) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<SupplierRow | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      contact: "",
      notes: "",
      credit_limit: "",
      payment_terms_days: "",
      terms_note: "",
    },
  });

  React.useEffect(() => {
    if (dialogOpen) {
      reset(
        editing
          ? {
              name: editing.name,
              contact: editing.contact ?? "",
              notes: editing.notes ?? "",
              credit_limit:
                editing.credit_limit != null
                  ? (editing.credit_limit / 100).toFixed(2)
                  : "",
              payment_terms_days:
                editing.payment_terms_days != null
                  ? String(editing.payment_terms_days)
                  : "",
              terms_note: editing.terms_note ?? "",
            }
          : {
              name: "",
              contact: "",
              notes: "",
              credit_limit: "",
              payment_terms_days: "",
              terms_note: "",
            }
      );
    }
  }, [dialogOpen, editing, reset]);

  async function onSubmit(values: FormValues) {
    const res = await upsertSupplier({
      id: editing?.id,
      name: values.name,
      contact: values.contact,
      notes: values.notes,
      terms_note: values.terms_note,
      credit_limit:
        values.credit_limit.trim() === ""
          ? null
          : parsePesosToCentavos(values.credit_limit),
      payment_terms_days:
        values.payment_terms_days.trim() === ""
          ? null
          : parseInt(values.payment_terms_days, 10),
    });
    if (res.ok) {
      toast.success(editing ? "Supplier updated" : "Supplier added");
      setDialogOpen(false);
    } else toast.error(res.error);
  }

  const [deleting, setDeleting] = React.useState<SupplierRow | null>(null);

  const columns: ColumnDef<SupplierRow>[] = [
    {
      accessorKey: "name",
      header: ({ column }) => <SortableHeader column={column}>Supplier</SortableHeader>,
      cell: ({ getValue }) => <span className="font-medium">{getValue<string>()}</span>,
    },
    {
      accessorKey: "contact",
      header: "Contact",
      cell: ({ getValue }) =>
        getValue<string | null>() ?? <span className="text-muted-foreground">—</span>,
    },
    {
      accessorKey: "outstanding",
      header: ({ column }) => <SortableHeader column={column}>We owe</SortableHeader>,
      cell: ({ row }) => {
        const owed = row.original.outstanding ?? 0;
        const pct = row.original.utilization_pct;
        const limit = row.original.credit_limit;
        return (
          <div className="min-w-32">
            <span
              className={cn(
                "tabular-nums font-medium",
                owed === 0 && "text-muted-foreground",
                pct != null && pct >= 100 && "text-destructive",
                pct != null && pct >= 80 && pct < 100 && "text-warning-foreground"
              )}
            >
              {formatCentavos(owed)}
            </span>
            {limit != null && (
              <div className="text-xs text-muted-foreground">
                of {formatCentavos(limit)}
                {pct != null && ` · ${pct}%`}
              </div>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: "payment_terms_days",
      header: "Terms",
      cell: ({ getValue }) => {
        const d = getValue<number | null>();
        return d != null ? (
          <span className="text-sm">Net {d}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        );
      },
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Row actions">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => {
                setEditing(row.original);
                setDialogOpen(true);
              }}
            >
              <Pencil className="size-4" /> Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setDeleting(row.original)}
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
        data={suppliers}
        searchPlaceholder="Search suppliers…"
        emptyMessage="No suppliers yet."
        toolbar={
          <Button
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="size-4" /> Add Supplier
          </Button>
        }
      />
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Supplier" : "Add Supplier"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="sup-name">Name</Label>
              <Input id="sup-name" {...register("name")} />
              {errors.name && (
                <p className="text-sm text-destructive">{errors.name.message}</p>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sup-contact">Contact (phone / person)</Label>
              <Input id="sup-contact" {...register("contact")} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sup-notes">Notes</Label>
              <Textarea id="sup-notes" rows={2} {...register("notes")} />
            </div>

            {/* Credit terms */}
            <div className="grid gap-3 rounded-md border bg-muted/30 p-3">
              <div>
                <Label className="text-sm">Credit terms</Label>
                <p className="text-xs text-muted-foreground">
                  The limit only warns — you can always go over with a reason.
                </p>
              </div>
              {editing && (editing.outstanding ?? 0) > 0 && (
                <p className="rounded-md bg-background p-2 text-xs">
                  Currently owed{" "}
                  <span className="font-semibold tabular-nums">
                    {formatCentavos(editing.outstanding ?? 0)}
                  </span>
                  {editing.utilization_pct != null && (
                    <span className="text-muted-foreground">
                      {" "}
                      · {editing.utilization_pct}% of the limit
                    </span>
                  )}
                </p>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="sup-limit" className="text-xs">
                    Credit limit ₱
                  </Label>
                  <Input
                    id="sup-limit"
                    inputMode="decimal"
                    placeholder="blank = no limit"
                    {...register("credit_limit")}
                  />
                  {errors.credit_limit && (
                    <p className="text-xs text-destructive">
                      {errors.credit_limit.message}
                    </p>
                  )}
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="sup-terms" className="text-xs">
                    Payment terms (days)
                  </Label>
                  <Input
                    id="sup-terms"
                    inputMode="numeric"
                    placeholder="e.g. 30 for net 30"
                    {...register("payment_terms_days")}
                  />
                  {errors.payment_terms_days && (
                    <p className="text-xs text-destructive">
                      {errors.payment_terms_days.message}
                    </p>
                  )}
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="sup-terms-note" className="text-xs">
                  Terms note (optional)
                </Label>
                <Input
                  id="sup-terms-note"
                  placeholder="e.g. 2% discount if paid within 10 days"
                  {...register("terms_note")}
                />
              </div>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="size-4 animate-spin" />}
                {editing ? "Save" : "Add"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Remove supplier “${deleting?.name}”?`}
        description="Past receivings keep their history."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          const res = await softDeleteSupplier(deleting.id);
          if (res.ok) toast.success(`${deleting.name} removed`);
          else toast.error(res.error);
        }}
      />
    </>
  );
}
