"use client";

import * as React from "react";
import Link from "next/link";
import {
  Anchor,
  BarChart3,
  Boxes,
  Cake,
  KeyRound,
  Loader2,
  MapPin,
  MoreHorizontal,
  Package,
  Pencil,
  Plus,
  Store,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
import { Textarea } from "@/components/ui/textarea";
import { DatePicker } from "@/components/date-picker";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  LocationPicker,
  MapPreview,
  type LatLng,
} from "@/components/location-picker";
import { ShopBadge } from "@/components/shop-badge";
import { SHOP_COLOR_KEYS, shopColorVars } from "@/lib/shop-colors";
import {
  ImageUploadField,
  type ImageAction,
} from "@/components/image-upload-field";
import { createClient } from "@/lib/supabase/client";
import { PRODUCT_IMAGE_BUCKET, productImageUrl } from "@/lib/product-image";
import {
  closeShop,
  createEmployee,
  setShopLogo,
  softDeleteStaff,
  updateEmployee,
  updateShopCredentials,
  upsertShop,
  upsertStaff,
} from "./actions";

export interface ShopRow {
  id: string;
  name: string;
  location: string | null;
  latitude: number | null;
  longitude: number | null;
  active: boolean;
  color_key: string | null;
  logo_path: string | null;
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
  birthday: string | null;
  image_path: string | null;
  notes: string | null;
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
  const [shopColor, setShopColor] = React.useState<string | null>(null);
  const [shopLogoAction, setShopLogoAction] = React.useState<ImageAction>({
    type: "keep",
  });

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

  // slim staff manager (people, not app logins — powers birthday reminders)
  const [staffEdit, setStaffEdit] = React.useState<{
    staff: StaffLite | null;
    shopId: string;
  } | null>(null);
  const [removingStaff, setRemovingStaff] = React.useState<StaffLite | null>(null);

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
    setShopColor(shop?.color_key ?? null);
    setShopLogoAction({ type: "keep" });
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
      color_key: shopColor,
    });

    // Logo: upload/remove the Storage object, then persist the path. Versioned
    // names give every replace a fresh URL; the old object is deleted after.
    // (Same pattern as product photos — see part-form-dialog.)
    const shopId = res.ok ? res.id : null;
    if (res.ok && shopId && shopLogoAction.type !== "keep") {
      const supabase = createClient();
      const oldPath = editingShop?.logo_path ?? null;
      if (shopLogoAction.type === "set") {
        const objectPath = `shop-logos/${shopId}-${Date.now()}.webp`;
        const { error } = await supabase.storage
          .from(PRODUCT_IMAGE_BUCKET)
          .upload(objectPath, shopLogoAction.image.blob, {
            contentType: "image/webp",
            cacheControl: "31536000",
          });
        if (error) {
          toast.error(`Shop saved, but the logo upload failed: ${error.message}`);
        } else {
          const set = await setShopLogo(shopId, objectPath);
          if (!set.ok) toast.error(set.error);
          else if (oldPath && oldPath !== objectPath) {
            await supabase.storage.from(PRODUCT_IMAGE_BUCKET).remove([oldPath]);
          }
        }
      } else {
        if (oldPath) {
          await supabase.storage.from(PRODUCT_IMAGE_BUCKET).remove([oldPath]);
        }
        const set = await setShopLogo(shopId, null);
        if (!set.ok) toast.error(set.error);
      }
    }

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
                  {/* identity tile in the shop's palette color (token-resolved) */}
                  <div
                    className="flex size-9 items-center justify-center rounded-md text-white"
                    style={{ backgroundColor: shopColorVars(shop.color_key).solid }}
                  >
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
                  <Button size="sm" asChild>
                    <Link href={`/shops/${shop.id}/stock`}>
                      <Package className="size-4" /> View stock
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
                  pinColor={
                    shop.color_key ? shopColorVars(shop.color_key).solid : undefined
                  }
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

              {/* The people who work at this shop (not app logins). Managed
                  here since Payroll was removed; powers birthday reminders. */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Employees ({shopStaff.length})
                  </h4>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => setStaffEdit({ staff: null, shopId: shop.id })}
                  >
                    <Plus className="size-3.5" /> Add Employee
                  </Button>
                </div>
                {shopStaff.length === 0 ? (
                  <p className="rounded-md border border-dashed py-4 text-center text-sm text-muted-foreground">
                    No employees yet — add the people who work here.
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
                        <Avatar className="size-7 shrink-0">
                          <AvatarImage
                            src={productImageUrl(p.image_path) ?? undefined}
                            alt={p.full_name}
                          />
                          <AvatarFallback className="text-xs">
                            {p.full_name
                              .split(/\s+/)
                              .map((w) => w[0])
                              .slice(0, 2)
                              .join("")
                              .toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">
                            {p.full_name}
                          </div>
                          <div className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                            {p.birthday ? (
                              <>
                                <Cake className="size-3" />
                                {format(new Date(p.birthday + "T00:00:00"), "MMM d")}
                              </>
                            ) : (
                              "No birthday set"
                            )}
                            {!p.active && " · inactive"}
                          </div>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-6 shrink-0"
                              aria-label={`Actions for ${p.full_name}`}
                            >
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() =>
                                setStaffEdit({ staff: p, shopId: p.shop_id })
                              }
                            >
                              <Pencil className="size-4" /> Edit
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => setRemovingStaff(p)}
                            >
                              <Trash2 className="size-4" /> Remove
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
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
              <Label>Shop logo</Label>
              <p className="text-xs text-muted-foreground">
                Printed on this branch&apos;s receipts and warranty certificates,
                in place of the anchor. Optional — leave empty to keep the anchor.
              </p>
              <ImageUploadField
                currentPath={editingShop?.logo_path ?? null}
                action={shopLogoAction}
                onActionChange={setShopLogoAction}
              />
            </div>

            <div className="grid gap-2">
              <Label>Shop color</Label>
              <p className="text-xs text-muted-foreground">
                Marks this branch everywhere it appears — lists, charts, its map
                pin. One color per shop; the name is always shown with it.
              </p>
              {/* one compact row of circles; the preview below carries the name */}
              <div className="flex flex-wrap items-center gap-2">
                {SHOP_COLOR_KEYS.map((key) => {
                  const takenByOther = shops.find(
                    (s) => s.color_key === key && s.id !== editingShop?.id
                  );
                  const selected = shopColor === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      disabled={!!takenByOther}
                      onClick={() => setShopColor(selected ? null : key)}
                      title={takenByOther ? `Used by ${takenByOther.name}` : key}
                      aria-pressed={selected}
                      aria-label={`Color ${key}${takenByOther ? ` — used by ${takenByOther.name}` : ""}`}
                      className={`size-7 rounded-full transition-shadow ${
                        selected
                          ? "ring-2 ring-ring ring-offset-2 ring-offset-background"
                          : "hover:ring-2 hover:ring-ring/40 hover:ring-offset-1 hover:ring-offset-background"
                      } ${takenByOther ? "cursor-not-allowed opacity-25" : ""}`}
                      style={{ backgroundColor: shopColorVars(key).solid }}
                    />
                  );
                })}
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                Preview:
                <ShopBadge
                  shop={{ name: shopName.trim() || "Shop name", color_key: shopColor }}
                />
                {shopColor === null && "(neutral — tap a circle to pick, tap again to clear; greyed = taken)"}
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

      {/* Slim staff manager — people (not app logins); powers birthday reminders */}
      <StaffDialog
        edit={staffEdit}
        shops={shops}
        onClose={() => setStaffEdit(null)}
      />
      <ConfirmDialog
        open={removingStaff !== null}
        onOpenChange={(o) => !o && setRemovingStaff(null)}
        title={`Remove ${removingStaff?.full_name}?`}
        description="They disappear from lists and birthday reminders. This can't be undone here."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (!removingStaff) return;
          const res = await softDeleteStaff(removingStaff.id);
          if (res.ok) toast.success(`${removingStaff.full_name} removed`);
          else toast.error(res.error);
        }}
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
          text: `${staffCount} employee(s) still assigned here`,
          fix: "the Employees list on this shop's card — deactivate or remove them",
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

/**
 * Add/edit a shop's staff member — the people who work there, not app logins.
 * Slim on purpose (payroll is gone): name, shop, birthday, photo, notes. The
 * birthday is what powers the Dashboard/nav reminder. Photo rides the same
 * public product-images pipeline as shop logos and staff photos always have.
 */
function StaffDialog({
  edit,
  shops,
  onClose,
}: {
  edit: { staff: StaffLite | null; shopId: string } | null;
  shops: ShopRow[];
  onClose: () => void;
}) {
  const [name, setName] = React.useState("");
  const [shopId, setShopId] = React.useState("");
  const [birthday, setBirthday] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [active, setActive] = React.useState(true);
  const [photo, setPhoto] = React.useState<ImageAction>({ type: "keep" });
  const [busy, setBusy] = React.useState(false);

  const staff = edit?.staff ?? null;
  React.useEffect(() => {
    if (!edit) return;
    setName(staff?.full_name ?? "");
    setShopId(staff?.shop_id ?? edit.shopId);
    setBirthday(staff?.birthday ?? "");
    setNotes(staff?.notes ?? "");
    setActive(staff?.active ?? true);
    setPhoto({ type: "keep" });
  }, [edit, staff]);

  async function onSave() {
    setBusy(true);
    // Photo → public product-images bucket under a random name, uploaded before
    // the upsert so it never depends on a not-yet-created staff id.
    const supabase = createClient();
    const oldPath = staff?.image_path ?? null;
    let imagePath = oldPath;
    if (photo.type === "set") {
      const objectPath = `staff-photos/${crypto.randomUUID()}.webp`;
      const { error } = await supabase.storage
        .from(PRODUCT_IMAGE_BUCKET)
        .upload(objectPath, photo.image.blob, {
          contentType: "image/webp",
          cacheControl: "31536000",
        });
      if (error) {
        setBusy(false);
        toast.error(`Photo upload failed: ${error.message}`);
        return;
      }
      imagePath = objectPath;
    } else if (photo.type === "remove") {
      imagePath = null;
    }

    const res = await upsertStaff({
      id: staff?.id,
      full_name: name,
      shop_id: shopId,
      birthday: birthday || null,
      notes: notes || null,
      active,
      image_path: imagePath,
    });
    setBusy(false);
    if (res.ok) {
      if (oldPath && oldPath !== imagePath) {
        await supabase.storage.from(PRODUCT_IMAGE_BUCKET).remove([oldPath]);
      }
      toast.success(staff ? "Employee updated" : "Employee added");
      onClose();
    } else toast.error(res.error);
  }

  return (
    <Dialog open={edit !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="thin-scrollbar max-h-[92svh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{staff ? "Edit Employee" : "Add Employee"}</DialogTitle>
          <DialogDescription>
            The people who work at this shop. A birthday turns on the reminder
            on the Dashboard and in the nav.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="staff-name">Full name</Label>
            <Input
              id="staff-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Juan Dela Cruz"
            />
          </div>
          <div className="grid gap-2">
            <Label>Photo (optional)</Label>
            <ImageUploadField
              currentPath={staff?.image_path ?? null}
              action={photo}
              onActionChange={setPhoto}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid min-w-0 gap-2">
              <Label>Shop</Label>
              <Select value={shopId} onValueChange={setShopId}>
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
            <div className="grid gap-2">
              <Label>Birthday</Label>
              <DatePicker value={birthday} onChange={setBirthday} className="w-full" />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="staff-notes">Notes (optional)</Label>
            <Textarea
              id="staff-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          {staff && (
            <Label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                checked={active}
                onCheckedChange={(v) => setActive(v === true)}
              />
              Active
            </Label>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={busy || name.trim() === "" || !shopId}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {staff ? "Save" : "Add employee"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
