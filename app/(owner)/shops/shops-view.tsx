"use client";

import * as React from "react";
import Link from "next/link";
import {
  Anchor,
  Boxes,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Store,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  closeShop,
  createEmployee,
  resetEmployeePassword,
  updateEmployee,
  upsertShop,
} from "./actions";

export interface ShopRow {
  id: string;
  name: string;
  location: string | null;
  active: boolean;
  part_units: number;
  engine_count: number;
  pending_count: number;
}

export interface EmployeeRow {
  id: string;
  full_name: string;
  role: "owner" | "employee";
  shop_id: string | null;
  shop_name: string | null;
  active: boolean;
  email: string;
}

export function ShopsView({
  shops,
  employees,
}: {
  shops: ShopRow[];
  employees: EmployeeRow[];
}) {
  // shop dialog
  const [shopDialog, setShopDialog] = React.useState(false);
  const [editingShop, setEditingShop] = React.useState<ShopRow | null>(null);
  const [shopName, setShopName] = React.useState("");
  const [shopLocation, setShopLocation] = React.useState("");
  const [shopActive, setShopActive] = React.useState(true);

  // employee dialogs
  const [empDialog, setEmpDialog] = React.useState(false);
  const [editingEmp, setEditingEmp] = React.useState<EmployeeRow | null>(null);
  const [empName, setEmpName] = React.useState("");
  const [empEmail, setEmpEmail] = React.useState("");
  const [empPassword, setEmpPassword] = React.useState("");
  const [empShop, setEmpShop] = React.useState("");
  const [empActive, setEmpActive] = React.useState(true);

  const [resetFor, setResetFor] = React.useState<EmployeeRow | null>(null);
  const [resetPw, setResetPw] = React.useState("");
  const [closing, setClosing] = React.useState<ShopRow | null>(null);

  const [busy, setBusy] = React.useState(false);

  const owners = employees.filter((e) => e.role === "owner");

  function openShopDialog(shop: ShopRow | null) {
    setEditingShop(shop);
    setShopName(shop?.name ?? "");
    setShopLocation(shop?.location ?? "");
    setShopActive(shop?.active ?? true);
    setShopDialog(true);
  }

  function openEmpDialog(emp: EmployeeRow | null, presetShopId?: string) {
    setEditingEmp(emp);
    setEmpName(emp?.full_name ?? "");
    setEmpEmail(emp?.email ?? "");
    setEmpPassword("");
    setEmpShop(emp?.shop_id ?? presetShopId ?? "");
    setEmpActive(emp?.active ?? true);
    setEmpDialog(true);
  }

  async function onSaveShop() {
    setBusy(true);
    const res = await upsertShop({
      id: editingShop?.id,
      name: shopName,
      location: shopLocation || null,
      active: shopActive,
    });
    setBusy(false);
    if (res.ok) {
      toast.success(editingShop ? "Shop updated" : "Shop created");
      setShopDialog(false);
    } else toast.error(res.error);
  }

  async function onSaveEmployee() {
    setBusy(true);
    const res = editingEmp
      ? await updateEmployee({
          id: editingEmp.id,
          full_name: empName,
          shop_id: empShop,
          active: empActive,
        })
      : await createEmployee({
          email: empEmail,
          password: empPassword,
          full_name: empName,
          shop_id: empShop,
        });
    setBusy(false);
    if (res.ok) {
      toast.success(editingEmp ? "Employee updated" : "Employee account created");
      setEmpDialog(false);
    } else toast.error(res.error);
  }

  async function onResetPassword() {
    if (!resetFor) return;
    setBusy(true);
    const res = await resetEmployeePassword({ id: resetFor.id, password: resetPw });
    setBusy(false);
    if (res.ok) {
      toast.success(`Password reset for ${resetFor.full_name}`);
      setResetFor(null);
      setResetPw("");
    } else toast.error(res.error);
  }

  /** One shared login per shop — helpers/cashiers are people, not accounts. */
  function ShopLoginRow({ account }: { account: EmployeeRow }) {
    return (
      <div
        className={`flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3 ${
          !account.active ? "opacity-60" : ""
        }`}
      >
        <div className="flex items-center gap-3">
          <div className="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <KeyRound className="size-4" />
          </div>
          <div>
            <div className="text-sm font-medium">
              {account.full_name}
              <Badge
                variant={account.active ? "secondary" : "destructive"}
                className="ml-2"
              >
                {account.active ? "Active" : "Disabled"}
              </Badge>
            </div>
            <div className="text-xs text-muted-foreground">
              Shop login · {account.email || "—"}
            </div>
          </div>
        </div>
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setResetPw("");
              setResetFor(account);
            }}
          >
            <KeyRound className="size-4" /> Reset password
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openEmpDialog(account)}
          >
            <Pencil className="size-4" /> Edit
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Shops &amp; Employees
          </h1>
          <p className="text-sm text-muted-foreground">
            One card per shop — stock at a glance and its single login account.
            Helpers and cashiers share the shop&apos;s login.
          </p>
        </div>
        <Button onClick={() => openShopDialog(null)}>
          <Plus className="size-4" /> Add shop
        </Button>
      </div>

      {/* Owner account */}
      {owners.length > 0 && (
        <Card>
          <CardHeader className="py-4">
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <UserRound className="size-4" />
              </div>
              <div>
                <CardTitle className="text-base">{owners[0].full_name}</CardTitle>
                <CardDescription>
                  Owner · {owners[0].email || "—"} · full access to everything
                </CardDescription>
              </div>
            </div>
          </CardHeader>
        </Card>
      )}

      {/* One card per shop */}
      {shops.map((shop) => {
        const staff = employees.filter(
          (e) => e.role === "employee" && e.shop_id === shop.id
        );
        return (
          <Card key={shop.id} className={!shop.active ? "opacity-75" : undefined}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="flex size-9 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
                    <Store className="size-4" />
                  </div>
                  <div>
                    <CardTitle className="text-base">
                      {shop.name}
                      {!shop.active && (
                        <Badge variant="secondary" className="ml-2">
                          Inactive
                        </Badge>
                      )}
                    </CardTitle>
                    <CardDescription>
                      {shop.location ?? "No location set"}
                    </CardDescription>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/shops/${shop.id}/stock`}>
                      <Boxes className="size-4" /> View stock
                    </Link>
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`More actions for ${shop.name}`}
                      >
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => openShopDialog(shop)}>
                        <Pencil className="size-4" /> Edit shop
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => setClosing(shop)}
                      >
                        <Trash2 className="size-4" /> Close shop permanently
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              {/* stock at a glance */}
              <div className="mt-1 flex flex-wrap gap-4 text-sm text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Boxes className="size-4" />
                  <span className="tabular-nums">{shop.part_units}</span> part unit
                  {shop.part_units === 1 ? "" : "s"}
                </span>
                <span className="flex items-center gap-1.5">
                  <Anchor className="size-4" />
                  <span className="tabular-nums">{shop.engine_count}</span> engine
                  {shop.engine_count === 1 ? "" : "s"}
                </span>
                <span className="flex items-center gap-1.5">
                  <KeyRound className="size-4" />
                  {staff.length === 0
                    ? "no login"
                    : staff.some((a) => a.active)
                      ? "login active"
                      : "login disabled"}
                </span>
              </div>
            </CardHeader>
            <CardContent>
              {staff.length === 0 ? (
                <div className="flex flex-col items-center gap-3 rounded-md border border-dashed py-5">
                  <p className="text-sm text-muted-foreground">
                    No login account yet — the shop can&apos;t sign in.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openEmpDialog(null, shop.id)}
                  >
                    <Plus className="size-4" /> Create shop login
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {staff.map((a) => (
                    <ShopLoginRow key={a.id} account={a} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}

      {shops.length === 0 && (
        <p className="rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground">
          No shops yet — create the first one.
        </p>
      )}

      {/* Shop dialog */}
      <Dialog open={shopDialog} onOpenChange={setShopDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingShop ? "Edit Shop" : "Add Shop"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="shop-name">Name</Label>
              <Input
                id="shop-name"
                value={shopName}
                onChange={(e) => setShopName(e.target.value)}
                placeholder="Branch 3 — Landing"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="shop-loc">Location</Label>
              <Input
                id="shop-loc"
                value={shopLocation}
                onChange={(e) => setShopLocation(e.target.value)}
              />
            </div>
            <Label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                checked={shopActive}
                onCheckedChange={(v) => setShopActive(v === true)}
              />
              Active (can receive deliveries)
            </Label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShopDialog(false)}>
              Cancel
            </Button>
            <Button onClick={onSaveShop} disabled={busy || shopName.trim() === ""}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {editingShop ? "Save" : "Create shop"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Employee dialog */}
      <Dialog open={empDialog} onOpenChange={setEmpDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingEmp ? "Edit Shop Login" : "Create Shop Login"}
            </DialogTitle>
            <DialogDescription>
              {editingEmp
                ? editingEmp.email
                : "One shared account per shop — everyone at the shop uses this login."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="emp-name">Account name</Label>
              <Input
                id="emp-name"
                value={empName}
                onChange={(e) => setEmpName(e.target.value)}
                placeholder="e.g. Branch 1 Counter"
              />
            </div>
            {!editingEmp && (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="emp-email">Login email</Label>
                  <Input
                    id="emp-email"
                    type="email"
                    value={empEmail}
                    onChange={(e) => setEmpEmail(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="emp-pass">Password (min 8 chars)</Label>
                  <Input
                    id="emp-pass"
                    type="text"
                    value={empPassword}
                    onChange={(e) => setEmpPassword(e.target.value)}
                    placeholder="They can't change it themselves — keep a record"
                  />
                </div>
              </>
            )}
            <div className="grid gap-2">
              <Label>Assigned shop</Label>
              <Select value={empShop} onValueChange={setEmpShop}>
                <SelectTrigger className="w-full max-w-full [&>span]:truncate">
                  <SelectValue placeholder="Pick a shop" />
                </SelectTrigger>
                <SelectContent>
                  {shops
                    .filter((s) => s.active)
                    .map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            {editingEmp && (
              <Label className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={empActive}
                  onCheckedChange={(v) => setEmpActive(v === true)}
                />
                Active (unchecking blocks this shop from signing in)
              </Label>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEmpDialog(false)}>
              Cancel
            </Button>
            <Button onClick={onSaveEmployee} disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {editingEmp ? "Save" : "Create account"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset password dialog */}
      <Dialog open={resetFor !== null} onOpenChange={(o) => !o && setResetFor(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Reset password — {resetFor?.full_name}</DialogTitle>
            <DialogDescription>
              Set a new password and hand it to the employee.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="reset-pw">New password (min 8 chars)</Label>
            <Input
              id="reset-pw"
              type="text"
              value={resetPw}
              onChange={(e) => setResetPw(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetFor(null)}>
              Cancel
            </Button>
            <Button onClick={onResetPassword} disabled={busy || resetPw.length < 8}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Reset password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Close shop — blockers shown upfront; server re-checks everything */}
      <CloseShopDialog
        shop={closing}
        staffCount={
          closing
            ? employees.filter(
                (e) => e.role === "employee" && e.shop_id === closing.id && e.active
              ).length
            : 0
        }
        onClose={() => setClosing(null)}
      />
    </div>
  );
}

function CloseShopDialog({
  shop,
  staffCount,
  onClose,
}: {
  shop: ShopRow | null;
  staffCount: number;
  onClose: () => void;
}) {
  const [busy, setBusy] = React.useState(false);

  const blockers = shop
    ? [
        shop.part_units > 0 && {
          text: `${shop.part_units} part unit(s) still at this shop`,
          fix: "Deliveries & Returns → New Return",
        },
        shop.engine_count > 0 && {
          text: `${shop.engine_count} engine(s) still at this shop`,
          fix: "Deliveries & Returns → New Return",
        },
        staffCount > 0 && {
          text: `${staffCount} active employee(s) still assigned`,
          fix: "Reassign or deactivate them below",
        },
        shop.pending_count > 0 && {
          text: `${shop.pending_count} submission(s) awaiting approval`,
          fix: "Approval Queue",
        },
      ].filter((b): b is { text: string; fix: string } => Boolean(b))
    : [];

  const canClose = blockers.length === 0;

  return (
    <Dialog open={shop !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {canClose
              ? `Close “${shop?.name}” permanently?`
              : `“${shop?.name}” can't be closed yet`}
          </DialogTitle>
          <DialogDescription>
            {canClose
              ? "Everything is settled. The shop disappears from lists and delivery targets, but its sales history, ledger entries, and warranties stay in the records."
              : "Nothing returns to master automatically — settle these first so the audit trail stays truthful:"}
          </DialogDescription>
        </DialogHeader>

        {!canClose && (
          <ul className="flex flex-col gap-2">
            {blockers.map((b, i) => (
              <li
                key={i}
                className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
              >
                <X className="mt-0.5 size-4 shrink-0 text-destructive" />
                <span>
                  {b.text}
                  <span className="block text-xs text-muted-foreground">→ {b.fix}</span>
                </span>
              </li>
            ))}
          </ul>
        )}

        <DialogFooter>
          {canClose ? (
            <>
              <Button variant="outline" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={async () => {
                  if (!shop) return;
                  setBusy(true);
                  const res = await closeShop(shop.id);
                  setBusy(false);
                  if (res.ok) {
                    toast.success(`${shop.name} closed`);
                    onClose();
                  } else {
                    toast.error(res.error);
                  }
                }}
              >
                {busy && <Loader2 className="size-4 animate-spin" />}
                Close shop
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={onClose}>
              Got it
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
