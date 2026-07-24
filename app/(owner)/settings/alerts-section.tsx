"use client";

import * as React from "react";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { updateAlertSettings } from "./actions";
import type { SettingsRow } from "./types";

/**
 * The alert thresholds, which until now existed only as columns with CHECK
 * constraints and no editor anywhere — changing either meant a SQL console.
 *
 * Each one says what it actually controls, because a number with no sentence
 * next to it is indistinguishable from decoration.
 */
export function AlertsSection({ settings }: { settings: SettingsRow }) {
  const [warrantyDays, setWarrantyDays] = React.useState(
    String(settings.warranty_expiry_alert_days)
  );
  const [warnPct, setWarnPct] = React.useState(String(settings.supplier_limit_warn_pct));
  const [staleDays, setStaleDays] = React.useState(String(settings.quote_stale_days));
  const [sukiEngine, setSukiEngine] = React.useState(
    String(settings.suki_engine_discount_pct ?? 10)
  );
  const [sukiPart, setSukiPart] = React.useState(
    String(settings.suki_part_discount_pct ?? 5)
  );
  const [busy, setBusy] = React.useState(false);

  async function onSave() {
    const days = parseInt(warrantyDays, 10);
    const pct = parseInt(warnPct, 10);
    const stale = parseInt(staleDays, 10);
    const sEngine = parseInt(sukiEngine, 10);
    const sPart = parseInt(sukiPart, 10);
    if (isNaN(days) || days < 0 || days > 365) {
      toast.error("Warranty alert lead time must be between 0 and 365 days");
      return;
    }
    if (isNaN(pct) || pct < 1 || pct > 100) {
      toast.error("Credit limit warning must be between 1 and 100 percent");
      return;
    }
    if (isNaN(stale) || stale < 1 || stale > 365) {
      toast.error("Quote staleness must be between 1 and 365 days");
      return;
    }
    if (isNaN(sEngine) || sEngine < 0 || sEngine > 100 || isNaN(sPart) || sPart < 0 || sPart > 100) {
      toast.error("Suki discounts must be between 0 and 100 percent");
      return;
    }
    setBusy(true);
    const res = await updateAlertSettings({
      warranty_expiry_alert_days: days,
      supplier_limit_warn_pct: pct,
      quote_stale_days: stale,
      suki_engine_discount_pct: sEngine,
      suki_part_discount_pct: sPart,
    });
    setBusy(false);
    if (res.ok) toast.success("Alert thresholds saved");
    else toast.error(res.error);
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle className="text-base">Alert thresholds</CardTitle>
        <CardDescription>
          When the system decides something is worth telling you about. Both are
          read live by the daily checks — no redeploy.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <div className="grid gap-2">
          <Label htmlFor="alert-warranty-days">Warranty expiry lead time (days)</Label>
          <Input
            id="alert-warranty-days"
            inputMode="numeric"
            className="w-32"
            value={warrantyDays}
            onChange={(e) => setWarrantyDays(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            How far ahead of expiry a warranty alert fires. Both you and the shop
            that sold the engine are told, once — an alert already sitting unread
            never re-sends. Checked daily at 9:00 AM PH. 0 means only on the day
            it expires.
          </p>
        </div>

        <Separator />

        <div className="grid gap-2">
          <Label htmlFor="alert-warn-pct">Supplier credit limit warning (%)</Label>
          <Input
            id="alert-warn-pct"
            inputMode="numeric"
            className="w-32"
            value={warnPct}
            onChange={(e) => setWarnPct(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            How much of a supplier&apos;s credit limit you can use before you get
            a warning. At 100% of the limit the warning becomes a
            limit-reached alert. Going over is never blocked — it asks for a
            reason and records it on the receiving.
          </p>
        </div>

        <Separator />

        <div className="grid gap-2">
          <Label htmlFor="alert-stale-days">Supplier quote staleness (days)</Label>
          <Input
            id="alert-stale-days"
            inputMode="numeric"
            className="w-32"
            value={staleDays}
            onChange={(e) => setStaleDays(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            A supplier quote older than this is flagged stale in a product&apos;s
            Suppliers &amp; Prices, and its effective price falls back to what you
            last actually paid. A quote past its own valid-until date goes stale
            regardless.
          </p>
        </div>

        <Separator />

        <div className="grid gap-2">
          <Label>Suki card discounts (%)</Label>
          <div className="flex items-center gap-4">
            <div className="grid gap-1">
              <Label htmlFor="suki-engine-pct" className="text-xs text-muted-foreground">
                Engines
              </Label>
              <Input
                id="suki-engine-pct"
                inputMode="numeric"
                className="w-24"
                value={sukiEngine}
                onChange={(e) => setSukiEngine(e.target.value)}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="suki-part-pct" className="text-xs text-muted-foreground">
                Parts
              </Label>
              <Input
                id="suki-part-pct"
                inputMode="numeric"
                className="w-24"
                value={sukiPart}
                onChange={(e) => setSukiPart(e.target.value)}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            What a scanned suki card takes off the catalog price at Record Sale
            — applied server-side and always capped so nothing sells at or
            below cost. Changing a rate affects new sales only.
          </p>
        </div>

        <div>
          <Button onClick={onSave} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save thresholds
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
