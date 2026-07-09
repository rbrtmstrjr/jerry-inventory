"use client";

import * as React from "react";
import { Loader2, Palette, Save } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { updateSettings } from "./actions";

interface Settings {
  business_name: string;
  address: string | null;
  phone: string | null;
  receipt_footer: string | null;
  default_warranty_months: number;
}

export function SettingsForm({ settings }: { settings: Settings }) {
  const [form, setForm] = React.useState({
    business_name: settings.business_name,
    address: settings.address ?? "",
    phone: settings.phone ?? "",
    receipt_footer: settings.receipt_footer ?? "",
    default_warranty_months: String(settings.default_warranty_months),
  });
  const [busy, setBusy] = React.useState(false);

  async function onSave() {
    const months = parseInt(form.default_warranty_months || "12", 10);
    if (isNaN(months) || months < 0) {
      toast.error("Warranty months must be a number");
      return;
    }
    setBusy(true);
    const res = await updateSettings({
      business_name: form.business_name,
      address: form.address || null,
      phone: form.phone || null,
      receipt_footer: form.receipt_footer || null,
      default_warranty_months: months,
    });
    setBusy(false);
    if (res.ok) toast.success("Settings saved");
    else toast.error(res.error);
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Business info used on delivery notes, warranty certificates, and count sheets.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Business</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="set-name">Business name</Label>
            <Input
              id="set-name"
              value={form.business_name}
              onChange={(e) => setForm((f) => ({ ...f, business_name: e.target.value }))}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="set-address">Address</Label>
              <Input
                id="set-address"
                value={form.address}
                onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="set-phone">Phone</Label>
              <Input
                id="set-phone"
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="set-footer">Receipt / document footer</Label>
            <Textarea
              id="set-footer"
              rows={2}
              value={form.receipt_footer}
              onChange={(e) => setForm((f) => ({ ...f, receipt_footer: e.target.value }))}
              placeholder="e.g. Salamat sa inyong pagtangkilik!"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="set-warranty">Default engine warranty (months)</Label>
            <Input
              id="set-warranty"
              inputMode="numeric"
              className="w-32"
              value={form.default_warranty_months}
              onChange={(e) =>
                setForm((f) => ({ ...f, default_warranty_months: e.target.value }))
              }
            />
            <p className="text-xs text-muted-foreground">
              Used when neither the engine nor its model sets a warranty term.
            </p>
          </div>
          <div>
            <Button onClick={onSave} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              Save settings
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Palette className="size-4" /> Branding
          </CardTitle>
          <CardDescription>
            All colors, radii, and theme tokens live in{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">app/theme.css</code>{" "}
            — one file, light and dark sets. Rebranding the whole app means
            editing that file only; components never hardcode colors. Chart
            colors are colorblind-validated — re-run the palette validator if
            you change them.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
