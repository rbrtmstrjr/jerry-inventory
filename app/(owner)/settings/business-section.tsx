"use client";

import * as React from "react";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { updateBusinessSettings, updateDefaults } from "./actions";
import type { SettingsRow } from "./types";

/**
 * Business identity + business defaults.
 *
 * Two cards on purpose. The first is what gets PRINTED — every field lands in
 * the header of all six documents, so a typo here is a typo on paper handed to
 * a customer. The second is a policy default that is never printed. Mixing them
 * in one form invites editing the warranty term while thinking about letterhead.
 */
export function BusinessSection({ settings }: { settings: SettingsRow }) {
  return (
    <div className="flex flex-col gap-4">
      <IdentityCard settings={settings} />
      <DefaultsCard settings={settings} />
    </div>
  );
}

function IdentityCard({ settings }: { settings: SettingsRow }) {
  const [form, setForm] = React.useState({
    business_name: settings.business_name,
    address: settings.address ?? "",
    phone: settings.phone ?? "",
    business_email: settings.business_email ?? "",
    business_tin: settings.business_tin ?? "",
    receipt_footer: settings.receipt_footer ?? "",
  });
  const [busy, setBusy] = React.useState(false);

  async function onSave() {
    setBusy(true);
    const res = await updateBusinessSettings({
      business_name: form.business_name,
      address: form.address || null,
      phone: form.phone || null,
      business_email: form.business_email || null,
      business_tin: form.business_tin || null,
      receipt_footer: form.receipt_footer || null,
    });
    setBusy(false);
    if (res.ok) toast.success("Business info saved — it's on every document now");
    else toast.error(res.error);
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle className="text-base">Business identity</CardTitle>
        <CardDescription>
          Printed on all six documents: sale receipt, delivery note, warranty
          certificate, payslip, count sheet and supplier purchase list.
        </CardDescription>
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

        <div className="grid gap-2">
          <Label htmlFor="set-address">Address</Label>
          <Input
            id="set-address"
            value={form.address}
            onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="set-phone">Contact number</Label>
            <Input
              id="set-phone"
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="set-email">Business email</Label>
            <Input
              id="set-email"
              type="email"
              value={form.business_email}
              onChange={(e) => setForm((f) => ({ ...f, business_email: e.target.value }))}
            />
            {/* Worth saying plainly: people assume editing this changes how they
                sign in, and it does not. */}
            <p className="text-xs text-muted-foreground">
              Printed on documents. This is not your sign-in email — change that
              under Account.
            </p>
          </div>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="set-tin">TIN</Label>
          <Input
            id="set-tin"
            className="sm:w-64"
            value={form.business_tin}
            onChange={(e) => setForm((f) => ({ ...f, business_tin: e.target.value }))}
            placeholder="000-000-000-000"
          />
          <p className="text-xs text-muted-foreground">
            Taxpayer Identification Number, printed on the sale receipt.
          </p>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="set-footer">Receipt footer</Label>
          <Textarea
            id="set-footer"
            rows={2}
            value={form.receipt_footer}
            onChange={(e) => setForm((f) => ({ ...f, receipt_footer: e.target.value }))}
            placeholder="e.g. Salamat po! Come again."
          />
          <p className="text-xs text-muted-foreground">
            Closing line at the bottom of the sale receipt.
          </p>
        </div>

        <div>
          <Button onClick={onSave} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save business info
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DefaultsCard({ settings }: { settings: SettingsRow }) {
  const [months, setMonths] = React.useState(String(settings.default_warranty_months));
  const [busy, setBusy] = React.useState(false);

  async function onSave() {
    const n = parseInt(months, 10);
    if (isNaN(n) || n < 0) {
      toast.error("Warranty months must be a whole number");
      return;
    }
    setBusy(true);
    const res = await updateDefaults({ default_warranty_months: n });
    setBusy(false);
    if (res.ok) toast.success("Defaults saved");
    else toast.error(res.error);
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle className="text-base">Defaults</CardTitle>
        <CardDescription>Business policy — not printed on documents.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="set-warranty">Default engine warranty (months)</Label>
          <Input
            id="set-warranty"
            inputMode="numeric"
            className="w-32"
            value={months}
            onChange={(e) => setMonths(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            The last fallback only: an engine&apos;s own term wins, then its
            model&apos;s, then this. Changing it never alters a warranty already
            issued — those are stamped at approval.
          </p>
        </div>
        <div>
          <Button onClick={onSave} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save defaults
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
