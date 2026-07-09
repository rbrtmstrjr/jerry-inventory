"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { Loader2, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable, SortableHeader } from "@/components/data-table/data-table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { softDeleteExpenseCategory, upsertExpenseCategory } from "../actions";

export interface CategoryRow {
  id: string;
  name: string;
  sort_order: number;
  active: boolean;
  expense_count: number;
}

export function ExpenseCategoriesView({
  categories,
}: {
  categories: CategoryRow[];
}) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<CategoryRow | null>(null);
  const [removing, setRemoving] = React.useState<CategoryRow | null>(null);
  const [busy, setBusy] = React.useState(false);

  const [name, setName] = React.useState("");
  const [sortOrder, setSortOrder] = React.useState("100");
  const [active, setActive] = React.useState(true);

  function openDialog(c: CategoryRow | null) {
    setEditing(c);
    setName(c?.name ?? "");
    setSortOrder(String(c?.sort_order ?? 100));
    setActive(c?.active ?? true);
    setDialogOpen(true);
  }

  async function onSave() {
    const order = parseInt(sortOrder || "100", 10);
    setBusy(true);
    const res = await upsertExpenseCategory({
      id: editing?.id,
      name,
      sort_order: isNaN(order) ? 100 : order,
      active,
    });
    setBusy(false);
    if (res.ok) {
      toast.success(editing ? "Category updated" : "Category added");
      setDialogOpen(false);
    } else toast.error(res.error);
  }

  const columns: ColumnDef<CategoryRow>[] = [
    {
      accessorKey: "sort_order",
      header: ({ column }) => <SortableHeader column={column}>Order</SortableHeader>,
      cell: ({ getValue }) => (
        <span className="tabular-nums text-muted-foreground">{getValue<number>()}</span>
      ),
    },
    {
      accessorKey: "name",
      header: ({ column }) => <SortableHeader column={column}>Category</SortableHeader>,
      cell: ({ getValue }) => <span className="font-medium">{getValue<string>()}</span>,
    },
    {
      accessorKey: "expense_count",
      header: "Expenses",
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
              aria-label={`Actions for ${row.original.name}`}
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
        data={categories}
        searchPlaceholder="Search categories…"
        emptyMessage="No categories yet."
        toolbar={
          <Button onClick={() => openDialog(null)}>
            <Plus className="size-4" /> Add category
          </Button>
        }
      />

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Category" : "Add Category"}</DialogTitle>
            <DialogDescription>
              Lower order numbers appear first in pickers.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="cat-name">Name</Label>
              <Input
                id="cat-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Security"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cat-order">Sort order</Label>
              <Input
                id="cat-order"
                inputMode="numeric"
                className="w-28"
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value.replace(/\D/g, ""))}
              />
            </div>
            {editing && (
              <Label className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={active}
                  onCheckedChange={(v) => setActive(v === true)}
                />
                Active (inactive can&apos;t be picked for new expenses)
              </Label>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={onSave} disabled={busy || name.trim() === ""}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {editing ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove “${removing?.name}”?`}
        description={
          removing?.expense_count
            ? `${removing.expense_count} expense(s) keep this category on their record — it just can't be picked anymore.`
            : "It can no longer be picked; history stays intact."
        }
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (!removing) return;
          const res = await softDeleteExpenseCategory(removing.id);
          if (res.ok) toast.success(`${removing.name} removed`);
          else toast.error(res.error);
        }}
      />
    </>
  );
}
