"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import {
  Check,
  Inbox,
  Loader2,
  Merge,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShopBadge } from "@/components/shop-badge";
import { DataTable, SortableHeader } from "@/components/data-table/data-table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  approveProposedCategory,
  dismissProposedCategory,
  mergeProposedCategory,
  softDeleteExpenseCategory,
  upsertExpenseCategory,
} from "../actions";

export interface CategoryRow {
  id: string;
  name: string;
  sort_order: number;
  active: boolean;
  expense_count: number;
}

export interface ProposedCategoryRow {
  id: string;
  name: string;
  shop_name: string | null;
  shop_color_key: string | null;
  expense_count: number;
  non_rejected_count: number;
}

export function ExpenseCategoriesView({
  categories,
  proposed,
}: {
  categories: CategoryRow[];
  proposed: ProposedCategoryRow[];
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
    <div className="flex flex-col gap-6">
      {proposed.length > 0 && (
        <ProposedSection proposed={proposed} activeCategories={categories} />
      )}

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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shop-proposed categories — approve / rename / merge / dismiss
// ---------------------------------------------------------------------------
function ProposedSection({
  proposed,
  activeCategories,
}: {
  proposed: ProposedCategoryRow[];
  activeCategories: CategoryRow[];
}) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [renaming, setRenaming] = React.useState<ProposedCategoryRow | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [merging, setMerging] = React.useState<ProposedCategoryRow | null>(null);
  const [mergeTarget, setMergeTarget] = React.useState("");
  const [dismissing, setDismissing] = React.useState<ProposedCategoryRow | null>(null);

  async function run(
    id: string,
    fn: () => Promise<{ ok: boolean; error?: string }>,
    okMsg: string
  ) {
    setBusy(id);
    const res = await fn();
    setBusy(null);
    if (res.ok) {
      toast.success(okMsg);
      return true;
    }
    toast.error(res.error ?? "Something went wrong");
    return false;
  }

  return (
    <section className="overflow-hidden rounded-lg border border-warning/50">
      <div className="border-b bg-warning/10 px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Inbox className="size-4" /> Proposed by shops ({proposed.length})
        </h2>
        <p className="text-xs text-muted-foreground">
          New category names shops used when recording expenses. Approve to make
          one real, merge it into an existing category, or dismiss it. Proposals
          never appear in pickers or reports until approved.
        </p>
      </div>
      <div className="flex flex-col divide-y">
        {proposed.map((p) => (
          <div
            key={p.id}
            className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="font-medium">{p.name}</span>
              {p.shop_name && (
                <ShopBadge
                  shop={{ name: p.shop_name, color_key: p.shop_color_key }}
                />
              )}
              <span className="text-xs text-muted-foreground">
                {p.expense_count} expense{p.expense_count === 1 ? "" : "s"}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy === p.id}
                onClick={() =>
                  run(
                    p.id,
                    () => approveProposedCategory(p.id),
                    `“${p.name}” is now a category`
                  )
                }
              >
                {busy === p.id ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Check className="size-4" />
                )}
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy === p.id}
                onClick={() => {
                  setRenameValue(p.name);
                  setRenaming(p);
                }}
              >
                <Pencil className="size-4" /> Rename
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy === p.id}
                onClick={() => {
                  setMergeTarget("");
                  setMerging(p);
                }}
              >
                <Merge className="size-4" /> Merge
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-destructive"
                disabled={busy === p.id}
                onClick={() => {
                  if (p.non_rejected_count > 0) {
                    toast.error(
                      `${p.non_rejected_count} expense(s) still use “${p.name}” — merge it into an existing category instead`
                    );
                    return;
                  }
                  setDismissing(p);
                }}
              >
                <X className="size-4" /> Dismiss
              </Button>
            </div>
          </div>
        ))}
      </div>

      {/* Rename → approve */}
      <Dialog open={renaming !== null} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename and approve</DialogTitle>
            <DialogDescription>
              The proposal becomes an active category under this name; its
              expenses follow along.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="proposal-name">Name</Label>
            <Input
              id="proposal-name"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy !== null || renameValue.trim() === ""}
              onClick={async () => {
                if (!renaming) return;
                const ok = await run(
                  renaming.id,
                  () => approveProposedCategory(renaming.id, renameValue),
                  `“${renameValue.trim()}” is now a category`
                );
                if (ok) setRenaming(null);
              }}
            >
              {busy !== null && <Loader2 className="size-4 animate-spin" />}
              Rename & approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Merge into an existing category */}
      <Dialog open={merging !== null} onOpenChange={(o) => !o && setMerging(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Merge “{merging?.name}”</DialogTitle>
            <DialogDescription>
              Its {merging?.expense_count ?? 0} expense
              {merging?.expense_count === 1 ? "" : "s"} move to the category you
              pick; the proposal is retired and never becomes a category.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label>Merge into</Label>
            <Select value={mergeTarget} onValueChange={setMergeTarget}>
              <SelectTrigger className="w-full max-w-full [&>span]:truncate">
                <SelectValue placeholder="Pick a category" />
              </SelectTrigger>
              <SelectContent>
                {activeCategories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMerging(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy !== null || !mergeTarget}
              onClick={async () => {
                if (!merging) return;
                const ok = await run(
                  merging.id,
                  () => mergeProposedCategory(merging.id, mergeTarget),
                  "Merged"
                );
                if (ok) setMerging(null);
              }}
            >
              {busy !== null && <Loader2 className="size-4 animate-spin" />}
              <Merge className="size-4" /> Merge
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={dismissing !== null}
        onOpenChange={(o) => !o && setDismissing(null)}
        title={`Dismiss “${dismissing?.name}”?`}
        description="No expense uses it — the proposal just goes away."
        confirmLabel="Dismiss"
        destructive
        onConfirm={async () => {
          if (!dismissing) return;
          await run(
            dismissing.id,
            () => dismissProposedCategory(dismissing.id),
            "Proposal dismissed"
          );
        }}
      />
    </section>
  );
}
