"use client";

import * as React from "react";
import { Loader2, MoreHorizontal, Pencil, Trash2, UserPlus, UserX, UserCheck } from "lucide-react";
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
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  createAdminAccount,
  deleteAdminAccount,
  setAdminActive,
  updateAdminCredentials,
} from "./actions";

export interface AdminAccountRow {
  id: string;
  full_name: string;
  email: string | null;
  active: boolean;
  last_sign_in_at: string | null;
}

/**
 * Admin accounts (0099) — the office logins Gerry hands out.
 *
 * An admin runs every daily operation but never sees Reports, Settings,
 * Shops & Employees, or Expense Reports. Deactivating one cuts app AND
 * database access on the spot (the profile's `active` flag feeds both);
 * deleting is only possible while the account has no recorded history.
 */
export function AdminAccountsSection({ admins }: { admins: AdminAccountRow[] }) {
  const [addOpen, setAddOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<AdminAccountRow | null>(null);
  const [deleting, setDeleting] = React.useState<AdminAccountRow | null>(null);
  const [toggling, setToggling] = React.useState<AdminAccountRow | null>(null);

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2">
          <div className="grid gap-1.5">
            <CardTitle className="text-base">Admin accounts</CardTitle>
            <CardDescription>
              Office logins that run daily operations — receiving, deliveries,
              approvals, expenses — without seeing Reports, Settings, or
              Shops&nbsp;&amp;&nbsp;Employees. Only you can manage them.
            </CardDescription>
          </div>
          <Button onClick={() => setAddOpen(true)}>
            <UserPlus className="size-4" /> Add admin
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {admins.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No admin accounts yet. Add one so the office can run the system
              while you&apos;re away.
            </p>
          )}
          {admins.map((a) => (
            <div
              key={a.id}
              className="flex items-center justify-between gap-2 rounded-md border p-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{a.full_name}</span>
                  {a.active ? (
                    <Badge variant="secondary">Active</Badge>
                  ) : (
                    <Badge variant="destructive">Deactivated</Badge>
                  )}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {a.email ?? "—"}
                  {a.last_sign_in_at && (
                    <>
                      {" · last sign-in "}
                      {new Date(a.last_sign_in_at).toLocaleString("en-PH", {
                        timeZone: "Asia/Manila",
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </>
                  )}
                </div>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label={`Actions for ${a.full_name}`}>
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setEditing(a)}>
                    <Pencil className="size-4" /> Edit name / credentials
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setToggling(a)}>
                    {a.active ? (
                      <>
                        <UserX className="size-4" /> Deactivate
                      </>
                    ) : (
                      <>
                        <UserCheck className="size-4" /> Reactivate
                      </>
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setDeleting(a)}>
                    <Trash2 className="size-4" /> Delete account
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </CardContent>
      </Card>

      <AddAdminDialog open={addOpen} onOpenChange={setAddOpen} />
      {editing && (
        <EditAdminDialog
          admin={editing}
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}

      <ConfirmDialog
        open={!!toggling}
        onOpenChange={(o) => !o && setToggling(null)}
        title={toggling?.active ? "Deactivate this admin?" : "Reactivate this admin?"}
        description={
          toggling?.active
            ? `${toggling?.full_name} will be signed out of everything and can no longer sign in. Their recorded history stays. You can reactivate any time.`
            : `${toggling?.full_name} will be able to sign in and work again.`
        }
        confirmLabel={toggling?.active ? "Deactivate" : "Reactivate"}
        destructive={!!toggling?.active}
        onConfirm={async () => {
          if (!toggling) return;
          const res = await setAdminActive({ id: toggling.id, active: !toggling.active });
          if (res.ok) toast.success(toggling.active ? "Admin deactivated" : "Admin reactivated");
          else toast.error(res.error);
          setToggling(null);
        }}
      />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this admin account?"
        description={`This permanently removes ${deleting?.full_name}'s login. It only works while the account has no recorded history — otherwise deactivate it instead.`}
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          const res = await deleteAdminAccount({ id: deleting.id });
          if (res.ok) toast.success("Admin account deleted");
          else toast.error(res.error);
          setDeleting(null);
        }}
      />
    </div>
  );
}

function AddAdminDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await createAdminAccount({ full_name: name, email, password });
    setBusy(false);
    if (res.ok) {
      toast.success(`Admin account created for ${name}`);
      setName(""); setEmail(""); setPassword("");
      onOpenChange(false);
    } else {
      toast.error(res.error);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add admin account</DialogTitle>
          <DialogDescription>
            A new office login. Share the email + password with the person who
            will run daily operations.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="adm-name">Name</Label>
            <Input id="adm-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="adm-email">Sign-in email</Label>
            <Input id="adm-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="adm-pass">Password</Label>
            <Input
              id="adm-pass"
              type="text"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" />} Create account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditAdminDialog({
  admin,
  open,
  onOpenChange,
}: {
  admin: AdminAccountRow;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [name, setName] = React.useState(admin.full_name);
  const [email, setEmail] = React.useState(admin.email ?? "");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await updateAdminCredentials({
      id: admin.id,
      ...(name.trim() && name.trim() !== admin.full_name ? { full_name: name.trim() } : {}),
      ...(email.trim() && email.trim() !== (admin.email ?? "") ? { email: email.trim() } : {}),
      ...(password ? { password } : {}),
    });
    setBusy(false);
    if (res.ok) {
      toast.success("Admin account updated");
      onOpenChange(false);
    } else {
      toast.error(res.error);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {admin.full_name}</DialogTitle>
          <DialogDescription>
            Change the name, sign-in email, or set a new password. Leave the
            password blank to keep the current one.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="adm-edit-name">Name</Label>
            <Input id="adm-edit-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="adm-edit-email">Sign-in email</Label>
            <Input id="adm-edit-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="adm-edit-pass">New password</Label>
            <Input
              id="adm-edit-pass"
              type="text"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank to keep the current password"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" />} Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
