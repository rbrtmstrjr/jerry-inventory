"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import type { SupplierRow } from "@/lib/db-types";
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
import { softDeleteSupplier, upsertSupplier } from "../actions";

const formSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  contact: z.string().optional(),
  notes: z.string().optional(),
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
    defaultValues: { name: "", contact: "", notes: "" },
  });

  React.useEffect(() => {
    if (dialogOpen) {
      reset(
        editing
          ? {
              name: editing.name,
              contact: editing.contact ?? "",
              notes: editing.notes ?? "",
            }
          : { name: "", contact: "", notes: "" }
      );
    }
  }, [dialogOpen, editing, reset]);

  async function onSubmit(values: FormValues) {
    const res = await upsertSupplier({ id: editing?.id, ...values });
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
      accessorKey: "notes",
      header: "Notes",
      cell: ({ getValue }) => (
        <span className="line-clamp-1 max-w-md text-muted-foreground">
          {getValue<string | null>() ?? "—"}
        </span>
      ),
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
