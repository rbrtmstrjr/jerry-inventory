"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ScanLine, Search } from "lucide-react";

import { formatCentavos } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { EngineLife, JournalRow } from "./types";

const phDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-PH", {
    timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short",
  });
const phDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-PH", {
    timeZone: "UTC", year: "numeric", month: "short", day: "2-digit",
  });

const STATE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" }> = {
  in_master: { label: "In master", variant: "secondary" },
  in_transit: { label: "In transit", variant: "secondary" },
  delivered: { label: "At shop", variant: "default" },
  sold: { label: "Sold", variant: "default" },
  returned: { label: "Returned", variant: "secondary" },
  written_off: { label: "Written off", variant: "destructive" },
};

/**
 * An engine has no balance — it is one unit with a life. So this is a timeline,
 * not a stock card: "where did engine #X go?" is the question, and every step
 * links to the document that caused it.
 */
function stepFor(m: JournalRow): { title: string; detail: string; href?: string; label?: string } {
  switch (m.movement_type) {
    case "received":
      return { title: "Received into master", detail: m.note ?? "", href: "/master-inventory/receiving", label: "Receiving" };
    case "delivery":
      return m.location_kind === "master"
        ? { title: "Sent from master", detail: m.note ?? "", href: m.delivery_id ? `/deliveries/${m.delivery_id}/note` : undefined, label: "Delivery note" }
        : { title: `Confirmed received by ${m.location_label}`, detail: m.note ?? "", href: m.delivery_id ? `/deliveries/${m.delivery_id}/note` : undefined, label: "Delivery note" };
    case "sale":
      return { title: `Sold at ${m.location_label}`, detail: m.note ?? "", href: m.sale_id ? `/approvals?item=sale:${m.sale_id}` : undefined, label: m.receipt_no ?? "Sale" };
    case "loss":
      return { title: `Written off at ${m.location_label}`, detail: [m.reason, m.note].filter(Boolean).join(" — "), href: m.loss_id ? `/approvals?item=loss:${m.loss_id}` : undefined, label: "Loss" };
    case "return":
      return m.location_kind === "master"
        ? { title: "Returned to master", detail: m.note ?? "" }
        : { title: `Returned from ${m.location_label}`, detail: m.note ?? "" };
    case "transit_return":
      return { title: "Recovered from transit", detail: m.note ?? "" };
    case "transit_writeoff":
      return { title: "Lost in transit — written off", detail: m.note ?? "" };
    default:
      return { title: m.movement_type, detail: m.note ?? "" };
  }
}

export function EngineHistoryView({
  serial, life, today,
}: {
  serial: string;
  life: EngineLife | null;
  today: string;
}) {
  const router = useRouter();
  const [q, setQ] = React.useState(serial);
  const ref = React.useRef<HTMLInputElement>(null);

  // Keyboard-wedge scanners type the serial then press Enter, so the field is
  // focused on arrival — scan a serial, see its whole life, same as the shop's
  // warranty lookup.
  React.useEffect(() => {
    ref.current?.focus();
  }, []);

  function search(e: React.FormEvent) {
    e.preventDefault();
    router.push(`/movements?tab=engines&serial=${encodeURIComponent(q.trim())}`);
  }

  const state = life ? (STATE[life.status] ?? { label: life.status, variant: "secondary" as const }) : null;

  return (
    <div className="flex flex-col gap-4">
      <Card className="print:hidden">
        <CardContent className="pt-6">
          <form onSubmit={search} className="grid gap-1">
            <Label htmlFor="eng-serial" className="text-xs">Serial number</Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <ScanLine className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="eng-serial"
                  ref={ref}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Scan or type a serial…"
                  className="pl-8 font-mono"
                  autoComplete="off"
                />
              </div>
              <Button type="submit" variant="outline" size="icon">
                <Search className="size-4" />
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {!serial ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Scan or enter a serial to trace an engine&apos;s whole life.
          </CardContent>
        </Card>
      ) : !life ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No engine with serial <span className="font-mono">{serial}</span>.
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader className="flex-row items-start justify-between gap-4">
              <div>
                <CardTitle className="font-mono text-base">{life.serial_number}</CardTitle>
                <CardDescription>
                  {life.brand} {life.model}
                  {life.horsepower != null && ` · ${life.horsepower}HP`}
                  {" · "}cost {formatCentavos(life.cost_centavos)}
                </CardDescription>
              </div>
              <div className="text-right">
                <Badge variant={state!.variant}>{state!.label}</Badge>
                {life.status === "delivered" && life.shop_name && (
                  <p className="mt-1 text-xs text-muted-foreground">{life.shop_name}</p>
                )}
                {life.status === "sold" && life.customer_name && (
                  <p className="mt-1 text-xs text-muted-foreground">{life.customer_name}</p>
                )}
              </div>
            </CardHeader>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Chain of custody</CardTitle>
              <CardDescription>
                Every movement this unit made, oldest first. Each step links to the
                document that caused it.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="relative border-l pl-6">
                {life.movements.map((m) => {
                  const s = stepFor(m);
                  return (
                    <li key={m.id} className="relative pb-6 last:pb-0">
                      <span className="absolute -left-[1.6rem] top-1 size-2.5 rounded-full bg-primary ring-4 ring-background" />
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                        <p className="font-medium">{s.title}</p>
                        <p className="text-xs text-muted-foreground">{phDateTime(m.created_at)}</p>
                      </div>
                      {s.detail && (
                        <p className="mt-0.5 text-sm text-muted-foreground">{s.detail}</p>
                      )}
                      <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                        {m.actor_name && <span>{m.actor_name}</span>}
                        {s.href && (
                          <Link href={s.href} className="underline underline-offset-4 hover:text-foreground">
                            {s.label}
                          </Link>
                        )}
                      </div>
                    </li>
                  );
                })}

                {life.warranty && (
                  <li className="relative pb-6 last:pb-0">
                    <span className="absolute -left-[1.6rem] top-1 size-2.5 rounded-full bg-chart-2 ring-4 ring-background" />
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                      <p className="font-medium">
                        Warranty issued — {life.warranty.months} months
                      </p>
                      <p className="text-xs text-muted-foreground">{phDate(life.warranty.sold_on)}</p>
                    </div>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      Expires {phDate(life.warranty.expires_on)}
                      {life.warranty.expires_on < today && " — expired"}
                    </p>
                    <Link
                      href={`/warranties/${life.warranty.id}/certificate`}
                      className="mt-1 inline-block text-xs underline underline-offset-4 hover:text-foreground"
                    >
                      Certificate
                    </Link>
                  </li>
                )}

                {life.warranty?.claims.map((c) => (
                  <li key={c.id} className="relative pb-6 last:pb-0">
                    <span className="absolute -left-[1.6rem] top-1 size-2.5 rounded-full bg-destructive ring-4 ring-background" />
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                      <p className="font-medium">Warranty claim — {c.status}</p>
                      <p className="text-xs text-muted-foreground">{phDate(c.claim_date)}</p>
                    </div>
                    <p className="mt-0.5 text-sm text-muted-foreground">{c.issue}</p>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
