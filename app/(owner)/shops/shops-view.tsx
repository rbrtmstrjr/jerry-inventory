"use client";

import * as React from "react";
import Link from "next/link";
import {
  Anchor,
  ArrowRight,
  BarChart3,
  Boxes,
  KeyRound,
  Loader2,
  MapPin,
  MoreHorizontal,
  Pencil,
  Plus,
  Store,
  Trash2,
  Users,
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
  LocationPicker,
  MapPreview,
  type LatLng,
} from "@/components/location-picker";
import {
  closeShop,
  createEmployee,
  updateEmployee,
  updateShopCredentials,
  upsertShop,
} from "./actions";

export interface ShopRow {
  id: string;
  name: string;
  location: string | null;
  latitude: number | null;
  longitude: number | null;
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

export interface StaffLite {
  id: string;
  full_name: string;
  shop_id: string;
  active: boolean;
  position: string | null;
}

export function ShopsView({
  shops,
  employees,
  staff: payrollStaff,
}: {
  shops: ShopRow[];
  employees: EmployeeRow[];
  staff: StaffLite[];
}) {
  // shop dialog
  const [shopDialog, setShopDialog] = React.useState(false);
  const [editingShop, setEditingShop] = React.useState<ShopRow | null>(null);
  const [shopName, setShopName] = React.useState("");
  const [shopLocation, setShopLocation] = React.useState("");
  const [shopPin, setShopPin] = React.useState<LatLng | null>(null);
  const [shopActive, setShopActive] = React.useState(true);

  // employee dialogs
  const [empDialog, setEmpDialog] = React.useState(false);
  const [editingEmp, setEditingEmp] = React.useState<EmployeeRow | null>(null);
  const [empName, setEmpName] = React.useState("");
  const [empEmail, setEmpEmail] = React.useState("");
  const [empPassword, setEmpPassword] = React.useState("");
  const [empShop, setEmpShop] = React.useState("");
  const [empActive, setEmpActive] = React.useState(true);

  const [credsFor, setCredsFor] = React.useState<EmployeeRow | null>(null);
  const [closing, setClosing] = React.useState<ShopRow | null>(null);

  const [busy, setBusy] = React.useState(false);

  function openShopDialog(shop: ShopRow | null) {
    setEditingShop(shop);
    setShopName(shop?.name ?? "");
    setShopLocation(shop?.location ?? "");
    setShopPin(
      shop?.latitude != null && shop?.longitude != null
        ? { lat: shop.latitude, lng: shop.longitude }
        : null
    );
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
      latitude: shopPin?.lat ?? null,
      longitude: shopPin?.lng ?? null,
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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          One card per shop — stock at a glance and its single shared login.
        </p>
        <Button onClick={() => openShopDialog(null)}>
          <Plus className="size-4" /> Add shop
        </Button>
      </div>

      {/* One card per shop — two per row on desktop */}
      <div className="grid items-start gap-6 lg:grid-cols-2">
      {shops.map((shop) => {
        const staff = employees.filter(
          (e) => e.role === "employee" && e.shop_id === shop.id
        );
        const shopStaff = payrollStaff.filter((p) => p.shop_id === shop.id);
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
                      {shop.latitude != null && shop.longitude != null && (
                        <>
                          {" · "}
                          <a
                            href={`https://www.google.com/maps?q=${shop.latitude},${shop.longitude}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-0.5 text-primary underline-offset-4 hover:underline"
                          >
                            <MapPin className="size-3" /> View on map
                          </a>
                        </>
                      )}
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
                      <DropdownMenuItem asChild>
                        <Link href={`/reports?tab=shops&shop=${shop.id}`}>
                          <BarChart3 className="size-4" /> View Reports
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => openShopDialog(shop)}>
                        <Pencil className="size-4" /> Edit Shop Details
                      </DropdownMenuItem>
                      {staff.length > 0 ? (
                        <DropdownMenuItem onClick={() => setCredsFor(staff[0])}>
                          <KeyRound className="size-4" /> Change Credentials
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem onClick={() => openEmpDialog(null, shop.id)}>
                          <KeyRound className="size-4" /> Create Login
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => setClosing(shop)}
                      >
                        <Trash2 className="size-4" /> Close Permanently
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
                  <Users className="size-4" />
                  <span className="tabular-nums">{shopStaff.length}</span>{" "}
                  employee{shopStaff.length === 1 ? "" : "s"}
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
            <CardContent className="flex flex-col gap-4">
              {shop.latitude != null && shop.longitude != null && (
                <MapPreview
                  lat={shop.latitude}
                  lng={shop.longitude}
                  label={shop.name}
                  className="h-44 w-full"
                />
              )}

              {staff.length === 0 && (
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
              )}

              {/* The people working at this shop (payroll staff) */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Employees ({shopStaff.length})
                  </h4>
                  <Button variant="ghost" size="xs" asChild>
                    <Link href="/payroll/staff">
                      Manage in Payroll <ArrowRight className="size-3.5" />
                    </Link>
                  </Button>
                </div>
                {shopStaff.length === 0 ? (
                  <p className="rounded-md border border-dashed py-4 text-center text-sm text-muted-foreground">
                    No employees yet — add the people who work here in Payroll
                    → Staff.
                  </p>
                ) : (
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {shopStaff.map((p) => (
                      <div
                        key={p.id}
                        className={`flex items-center gap-2.5 rounded-md border px-3 py-2 ${
                          !p.active ? "opacity-60" : ""
                        }`}
                      >
                        <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground">
                          {p.full_name
                            .split(/\s+/)
                            .map((w) => w[0])
                            .slice(0, 2)
                            .join("")
                            .toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">
                            {p.full_name}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {p.position ?? "No position"}
                            {!p.active && " · inactive"}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
      </div>

      {shops.length === 0 && (
        <p className="rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground">
          No shops yet — create the first one.
        </p>
      )}

      {/* Shop dialog */}
      <Dialog open={shopDialog} onOpenChange={setShopDialog}>
        <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingShop ? "Edit Shop" : "Add Shop"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid grid-cols-2 gap-4">
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
                <Label htmlFor="shop-loc">Location (text)</Label>
                <Input
                  id="shop-loc"
                  value={shopLocation}
                  onChange={(e) => setShopLocation(e.target.value)}
                  placeholder="e.g. Poblacion"
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Map pin (optional)</Label>
              {shopDialog && (
                <LocationPicker value={shopPin} onChange={setShopPin} />
              )}
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

      {/* Change credentials (email/username + optional new password + enable) */}
      <CredentialsDialog account={credsFor} onClose={() => setCredsFor(null)} />

      {/* Close shop — blockers shown upfront; server re-checks everything */}
      <CloseShopDialog
        shop={closing}
        loginActive={
          closing
            ? employees.some(
                (e) =>
                  e.role === "employee" && e.shop_id === closing.id && e.active
              )
            : false
        }
        staffCount={
          closing
            ? payrollStaff.filter((p) => p.shop_id === closing.id && p.active)
                .length
            : 0
        }
        onClose={() => setClosing(null)}
      />
    </div>
  );
}

/** Email/username + password + enabled state for a shop's shared login. */
function CredentialsDialog({
  account,
  onClose,
}: {
  account: EmployeeRow | null;
  onClose: () => void;
}) {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [active, setActive] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (account) {
      setEmail(account.email);
      setPassword("");
      setActive(account.active);
    }
  }, [account]);

  async function onSave() {
    if (!account) return;
    setBusy(true);
    const res = await updateShopCredentials({
      id: account.id,
      email: email.trim(),
      password: password || "",
      active,
    });
    setBusy(false);
    if (res.ok) {
      toast.success("Credentials updated");
      onClose();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <Dialog open={account !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change Credentials — {account?.shop_name}</DialogTitle>
          <DialogDescription>
            The shared login everyone at this shop uses. Hand any changes to
            the staff.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="cred-email">Login email (username)</Label>
            <Input
              id="cred-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cred-pass">New password</Label>
            <Input
              id="cred-pass"
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank to keep the current password"
            />
            {password !== "" && password.length < 8 && (
              <p className="text-xs text-destructive">At least 8 characters.</p>
            )}
          </div>
          <Label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              checked={active}
              onCheckedChange={(v) => setActive(v === true)}
            />
            Login enabled (unchecking blocks this shop from signing in)
          </Label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={onSave}
            disabled={
              busy ||
              email.trim() === "" ||
              (password !== "" && password.length < 8)
            }
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            Save credentials
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CloseShopDialog({
  shop,
  loginActive,
  staffCount,
  onClose,
}: {
  shop: ShopRow | null;
  loginActive: boolean;
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
        loginActive && {
          text: "The shop's login is still enabled",
          fix: "… menu → Change Credentials → untick “Login enabled”",
        },
        staffCount > 0 && {
          text: `${staffCount} employee(s) still on payroll here`,
          fix: "Payroll → Staff — deactivate or reassign them",
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
