"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Archive, Loader2, Plus, Save, Tag } from "lucide-react";
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
import { ConfirmDialog } from "@/components/confirm-dialog";
import { createCategory, softDeleteCategory, updateCategory } from "../actions";

export interface CategoryRow {
  id: string;
  name: string;
  usage: number;
}

export function CategoriesView({ categories }: { categories: CategoryRow[] }) {
  const router = useRouter();
  const [newName, setNewName] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  // editable name per row (server data is the source of truth; refresh resets)
  const [names, setNames] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(categories.map((c) => [c.id, c.name]))
  );
  const [busy, setBusy] = React.useState<string | null>(null);
  const [retiring, setRetiring] = React.useState<CategoryRow | null>(null);

  React.useEffect(() => {
    setNames(Object.fromEntries(categories.map((c) => [c.id, c.name])));
  }, [categories]);

  async function onAdd() {
    const n = newName.trim();
    if (!n) return;
    setAdding(true);
    const res = await createCategory(n);
    setAdding(false);
    if (res.ok) {
      toast.success(`“${n}” added`);
      setNewName("");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  async function onRename(c: CategoryRow) {
    const name = (names[c.id] ?? "").trim();
    if (name === c.name) return;
    setBusy(c.id);
    const res = await updateCategory(c.id, name);
    setBusy(null);
    if (res.ok) {
      toast.success("Category renamed");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Tag className="size-4" /> Product categories
          </CardTitle>
          <CardDescription>
            Organize and find products by type. Create, rename, or retire —
            retiring hides a category from pickers, but existing products keep it.
            New categories appear in every product picker immediately.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* New category */}
          <div className="flex items-end gap-2">
            <div className="grid flex-1 gap-1.5">
              <label htmlFor="new-cat" className="text-xs font-medium text-muted-foreground">
                New category
              </label>
              <Input
                id="new-cat"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onAdd();
                  }
                }}
                placeholder="e.g. Electrical, Safety Gear"
                maxLength={60}
              />
            </div>
            <Button onClick={onAdd} disabled={adding || newName.trim() === ""}>
              {adding ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Add category
            </Button>
          </div>

          {/* Existing categories */}
          {categories.length === 0 ? (
            <p className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground">
              No categories yet — add one above.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {categories.map((c) => (
                <div
                  key={c.id}
                  className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
                >
                  <Input
                    value={names[c.id] ?? ""}
                    onChange={(e) =>
                      setNames((n) => ({ ...n, [c.id]: e.target.value }))
                    }
                    onKeyDown={(e) => e.key === "Enter" && onRename(c)}
                    className="min-w-40 flex-1"
                    aria-label={`Rename ${c.name}`}
                    maxLength={60}
                  />
                  <Badge variant="secondary" className="tabular-nums">
                    {c.usage} product{c.usage === 1 ? "" : "s"}
                  </Badge>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Save ${c.name}`}
                    disabled={busy === c.id || (names[c.id] ?? "").trim() === c.name}
                    onClick={() => onRename(c)}
                  >
                    {busy === c.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Save className="size-4" />
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Retire ${c.name}`}
                    title="Retire (existing products keep it)"
                    onClick={() => setRetiring(c)}
                  >
                    <Archive className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={retiring !== null}
        onOpenChange={(o) => !o && setRetiring(null)}
        title={`Retire “${retiring?.name}”?`}
        description={
          retiring && retiring.usage > 0
            ? `It disappears from pickers. ${retiring.usage} product(s) keep it as their category.`
            : "It disappears from pickers. Existing products keep it."
        }
        confirmLabel="Retire"
        destructive
        onConfirm={async () => {
          if (!retiring) return;
          const res = await softDeleteCategory(retiring.id);
          if (res.ok) {
            toast.success(`${retiring.name} retired`);
            router.refresh();
          } else {
            toast.error(res.error);
          }
        }}
      />
    </div>
  );
}
