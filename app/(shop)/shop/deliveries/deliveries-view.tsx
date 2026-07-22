"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import {
  AlertTriangle,
  CheckCircle2,
  ImagePlus,
  Loader2,
  PackageCheck,
  Printer,
  Truck,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { ShopBadge } from "@/components/shop-badge";
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
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TabCountBadge } from "@/components/ui/tab-count-badge";
import { createClient } from "@/lib/supabase/client";
import { processProductImage, type ProcessedImage } from "@/lib/product-image";
import { RECEIPTS_BUCKET } from "@/components/receipt-image";
import { confirmDelivery } from "../actions";

export interface IncomingDelivery {
  id: string;
  shop_id: string;
  delivered_at: string;
  note: string | null;
  status: "in_transit" | "confirmed" | "discrepancy" | "resolved";
  confirmed_at: string | null;
  resolved_at: string | null;
  line_count: number;
  qty_sent: number;
  qty_outstanding: number;
  // set when this is a shop-to-shop transfer (null = a master delivery)
  from_shop_id: string | null;
  from_shop_name: string | null;
}

export interface IncomingLine {
  id: string;
  delivery_id: string;
  part_id: string | null;
  engine_id: string | null;
  name: string;
  unit: string;
  serial_number: string | null;
  qty_sent: number;
  qty_received: number | null;
  qty_outstanding: number;
  shop_note: string | null;
}

const STATUS: Record<
  IncomingDelivery["status"],
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  in_transit: { label: "On the way — confirm it", variant: "secondary" },
  confirmed: { label: "Received in full", variant: "default" },
  discrepancy: { label: "Discrepancy — with Admin", variant: "destructive" },
  resolved: { label: "Resolved by Admin", variant: "outline" },
};

/** Where a delivery came from: a source shop (transfer) or Admin / Master. */
function SourceLabel({ delivery }: { delivery: IncomingDelivery }) {
  if (delivery.from_shop_id) {
    return (
      <span className="inline-flex items-center gap-1">
        from{" "}
        <ShopBadge
          shop={{
            name: delivery.from_shop_name ?? "another shop",
            color_key: null,
          }}
        />
      </span>
    );
  }
  return <span className="text-muted-foreground">from Admin / Master</span>;
}

/** A transfer travels with a printable slip; a master delivery does not. */
function SlipLink({ delivery }: { delivery: IncomingDelivery }) {
  if (!delivery.from_shop_id) return null;
  return (
    <Button variant="outline" size="sm" asChild>
      <a
        href={`/transfer/${delivery.id}/slip`}
        target="_blank"
        rel="noopener noreferrer"
      >
        <Printer className="size-4" /> Print slip
      </a>
    </Button>
  );
}

/** The shop's copy of the delivery note (master deliveries; transfers use the slip). */
function NoteLink({ delivery }: { delivery: IncomingDelivery }) {
  if (delivery.from_shop_id) return null;
  return (
    <Button variant="outline" size="sm" asChild>
      <a
        href={`/shop/deliveries/${delivery.id}/note`}
        target="_blank"
        rel="noopener noreferrer"
      >
        <Printer className="size-4" /> Delivery note
      </a>
    </Button>
  );
}

export function ShopDeliveriesView({
  deliveries,
  lines,
}: {
  deliveries: IncomingDelivery[];
  lines: IncomingLine[];
}) {
  const linesFor = React.useCallback(
    (id: string) => lines.filter((l) => l.delivery_id === id),
    [lines]
  );

  const incoming = deliveries.filter((d) => d.status === "in_transit");
  const history = deliveries.filter((d) => d.status !== "in_transit");

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Incoming Deliveries
        </h1>
        <p className="text-sm text-muted-foreground">
          Count what actually arrives and confirm it. Stock only joins your shop
          once you confirm.
        </p>
      </div>

      <Tabs defaultValue="incoming">
        <TabsList>
          <TabsTrigger value="incoming">
            To confirm<TabCountBadge count={incoming.length} />
          </TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="incoming" className="flex flex-col gap-3 pt-2">
          {incoming.length === 0 && (
            <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              Nothing on the way right now.
            </p>
          )}
          {incoming.map((d) => (
            <ConfirmCard key={d.id} delivery={d} lines={linesFor(d.id)} />
          ))}
        </TabsContent>

        <TabsContent value="history" className="flex flex-col gap-3 pt-2">
          {history.length === 0 && (
            <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              No past deliveries yet.
            </p>
          )}
          {history.map((d) => (
            <HistoryCard key={d.id} delivery={d} lines={linesFor(d.id)} />
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * The shop's only actions: enter counts (good / damaged), note + photo the
 * damage, confirm. It still only RECORDS — good lands, damaged & missing go to
 * Admin to decide. Missing is computed (sent − good − damaged).
 */
function ConfirmCard({
  delivery,
  lines,
}: {
  delivery: IncomingDelivery;
  lines: IncomingLine[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  // good prefilled to what was sent — the common case is "everything arrived"
  const [good, setGood] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((l) => [l.id, String(l.qty_sent)]))
  );
  const [damaged, setDamaged] = React.useState<Record<string, string>>({});
  const [notes, setNotes] = React.useState<Record<string, string>>({});
  const [photos, setPhotos] = React.useState<Record<string, ProcessedImage>>({});

  const parsed = lines.map((l) => {
    const g = Math.max(0, parseInt(good[l.id] || "0", 10) || 0);
    const d = Math.max(0, parseInt(damaged[l.id] || "0", 10) || 0);
    return { line: l, good: g, damaged: d, missing: l.qty_sent - g - d, over: g + d > l.qty_sent };
  });
  const totalDamaged = parsed.reduce((s, p) => s + p.damaged, 0);
  const totalMissing = parsed.reduce((s, p) => s + Math.max(0, p.missing), 0);
  const over = parsed.some((p) => p.over);

  async function setPhoto(lineId: string, file: File | undefined | null) {
    if (!file) return;
    try {
      const img = await processProductImage(file);
      setPhotos((p) => ({ ...p, [lineId]: img }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't process that photo.");
    }
  }

  async function onConfirm() {
    if (over) {
      toast.error("Good + damaged can't be more than was sent");
      return;
    }
    setBusy(true);
    // upload damage photos first (own shop prefix) — track them so we can clean
    // up orphans if the confirm RPC fails.
    const supabase = createClient();
    const uploaded: string[] = [];
    const photoPathByLine: Record<string, string> = {};
    try {
      for (const p of parsed) {
        const img = photos[p.line.id];
        if (p.damaged > 0 && img) {
          const path = `shop-${delivery.shop_id}/delivery-${p.line.id}/${crypto.randomUUID()}.webp`;
          const { error } = await supabase.storage
            .from(RECEIPTS_BUCKET)
            .upload(path, img.blob, { contentType: "image/webp" });
          if (error) throw new Error(`Photo upload failed: ${error.message}`);
          uploaded.push(path);
          photoPathByLine[p.line.id] = path;
        }
      }
    } catch (e) {
      if (uploaded.length) await supabase.storage.from(RECEIPTS_BUCKET).remove(uploaded);
      setBusy(false);
      toast.error(e instanceof Error ? e.message : "Photo upload failed.");
      return;
    }

    const res = await confirmDelivery({
      delivery_id: delivery.id,
      lines: parsed.map((p) => ({
        line_id: p.line.id,
        qty_received: p.good,
        qty_damaged: p.damaged,
        shop_note: notes[p.line.id]?.trim() || null,
        damage_photo_path: photoPathByLine[p.line.id] ?? null,
      })),
    });
    setBusy(false);
    if (res.ok) {
      if (res.short > 0) {
        toast.success(
          `${res.landed} good · ${res.damaged} damaged · ${res.missing} missing — Admin will review the damaged & missing.`
        );
      } else {
        toast.success("Received in full — stock is now in your shop");
      }
      router.refresh();
    } else {
      // the RPC rejected — drop the just-uploaded photos so nothing is orphaned
      if (uploaded.length) await supabase.storage.from(RECEIPTS_BUCKET).remove(uploaded);
      toast.error(res.error);
    }
  }

  return (
    <Card className="border-primary/40">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Truck className="size-4" /> {delivery.line_count} item
            {delivery.line_count === 1 ? "" : "s"} on the way
          </CardTitle>
          <Badge variant={STATUS[delivery.status].variant}>
            {STATUS[delivery.status].label}
          </Badge>
        </div>
        <CardDescription className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
          <SourceLabel delivery={delivery} /> · Sent{" "}
          {format(new Date(delivery.delivered_at), "MMM d, yyyy h:mm a")}
          {delivery.note && ` · ${delivery.note}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          {parsed.map(({ line: l, damaged: d, missing, over: lineOver }) => (
            <div key={l.id} className="flex flex-col gap-2 rounded-md border px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {l.engine_id && (
                      <Badge variant="secondary" className="mr-1">
                        Engine
                      </Badge>
                    )}
                    {l.name}
                  </div>
                  {l.serial_number && (
                    <div className="font-mono text-xs text-muted-foreground">
                      SN {l.serial_number}
                    </div>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  sent{" "}
                  <span className="font-semibold text-foreground tabular-nums">
                    {l.qty_sent} {l.unit}
                  </span>
                </span>
                <div className="flex items-center gap-1">
                  <Label htmlFor={`good-${l.id}`} className="text-xs">Good</Label>
                  <Input
                    id={`good-${l.id}`}
                    inputMode="numeric"
                    value={good[l.id] ?? ""}
                    onChange={(e) =>
                      setGood((c) => ({ ...c, [l.id]: e.target.value.replace(/\D/g, "") }))
                    }
                    className={`w-16 tabular-nums ${lineOver ? "border-destructive" : ""}`}
                  />
                </div>
                <div className="flex items-center gap-1">
                  <Label htmlFor={`dmg-${l.id}`} className="text-xs">Damaged</Label>
                  <Input
                    id={`dmg-${l.id}`}
                    inputMode="numeric"
                    value={damaged[l.id] ?? ""}
                    onChange={(e) =>
                      setDamaged((c) => ({ ...c, [l.id]: e.target.value.replace(/\D/g, "") }))
                    }
                    placeholder="0"
                    className={`w-16 tabular-nums ${d > 0 ? "border-warning" : ""} ${lineOver ? "border-destructive" : ""}`}
                  />
                </div>
                <span className="text-xs tabular-nums text-muted-foreground">
                  Missing{" "}
                  <span className={missing > 0 ? "font-semibold text-warning-foreground" : ""}>
                    {Math.max(0, missing)}
                  </span>
                </span>
              </div>

              {lineOver && (
                <p className="text-xs font-medium text-destructive">
                  Good + damaged is more than the {l.qty_sent} sent.
                </p>
              )}

              {/* Damage evidence: note + photo, only when something's damaged */}
              {d > 0 && (
                <div className="flex flex-col gap-2 rounded-md bg-warning/5 p-2">
                  <Input
                    value={notes[l.id] ?? ""}
                    onChange={(e) => setNotes((n) => ({ ...n, [l.id]: e.target.value }))}
                    placeholder="What's the damage? (e.g. 1 box basa, casing cracked)"
                    className="text-xs"
                    aria-label={`Damage note for ${l.name}`}
                  />
                  <DamagePhoto
                    lineId={l.id}
                    image={photos[l.id] ?? null}
                    onPick={(f) => setPhoto(l.id, f)}
                    onClear={() =>
                      setPhotos((p) => {
                        const next = { ...p };
                        delete next[l.id];
                        return next;
                      })
                    }
                  />
                </div>
              )}
            </div>
          ))}
        </div>

        {(totalDamaged > 0 || totalMissing > 0) && !over && (
          <div className="flex items-start gap-2 rounded-md bg-warning/10 p-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
            <p className="text-xs text-warning-foreground">
              <span className="font-medium">
                {totalDamaged} damaged · {totalMissing} missing.
              </span>{" "}
              Good stock joins your shop now; Admin reviews the damaged & missing.
              You don&apos;t need to do anything else.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <SlipLink delivery={delivery} />
          <NoteLink delivery={delivery} />
          <Button onClick={onConfirm} disabled={busy || over}>
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <PackageCheck className="size-4" />
            )}
            Confirm what arrived
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** A compact damage-photo picker: choose → preview thumbnail → remove. */
function DamagePhoto({
  lineId,
  image,
  onPick,
  onClear,
}: {
  lineId: string;
  image: ProcessedImage | null;
  onPick: (file: File | undefined | null) => void;
  onClear: () => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-2">
      {image ? (
        <div className="relative size-14 overflow-hidden rounded-md border">
          {/* local object URL — plain img is correct */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image.previewUrl} alt="Damage" className="size-full object-cover" />
          <button
            type="button"
            onClick={onClear}
            aria-label="Remove photo"
            className="absolute right-0 top-0 rounded-bl bg-background/80 p-0.5 text-destructive"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
          <ImagePlus className="size-4" /> Add photo
        </Button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        aria-label={`Damage photo for line ${lineId}`}
        onChange={(e) => {
          onPick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** Read-only once confirmed — the shop has no further say. */
function HistoryCard({
  delivery,
  lines,
}: {
  delivery: IncomingDelivery;
  lines: IncomingLine[];
}) {
  const short = delivery.qty_outstanding;
  return (
    <Card className={delivery.status === "discrepancy" ? "border-warning" : ""}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            {delivery.status === "confirmed" ? (
              <CheckCircle2 className="size-4 text-success" />
            ) : (
              <Truck className="size-4" />
            )}
            {delivery.line_count} item{delivery.line_count === 1 ? "" : "s"}
          </CardTitle>
          <Badge variant={STATUS[delivery.status].variant}>
            {STATUS[delivery.status].label}
          </Badge>
        </div>
        <CardDescription className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
          <SourceLabel delivery={delivery} /> · Sent{" "}
          {format(new Date(delivery.delivered_at), "MMM d, yyyy")}
          {delivery.confirmed_at &&
            ` · confirmed ${format(new Date(delivery.confirmed_at), "MMM d, h:mm a")}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1 text-sm">
        {lines.map((l) => (
          <div key={l.id} className="flex flex-col">
            <div className="flex justify-between gap-2">
              <span className="truncate">{l.name}</span>
              <span className="tabular-nums text-xs">
                {l.qty_received ?? 0} of {l.qty_sent} {l.unit}
                {l.qty_outstanding > 0 && (
                  <span className="ml-1 font-medium text-warning-foreground">
                    · {l.qty_outstanding} missing
                  </span>
                )}
              </span>
            </div>
            {l.shop_note && (
              <span className="text-xs text-muted-foreground">“{l.shop_note}”</span>
            )}
          </div>
        ))}
        {short > 0 && (
          <p className="mt-1 rounded-md bg-accent p-2 text-xs text-accent-foreground">
            Waiting for Admin to review the {short} missing item
            {short === 1 ? "" : "s"}. Nothing more for you to do here.
          </p>
        )}
        <div className="mt-2 flex justify-end">
          <SlipLink delivery={delivery} />
          <NoteLink delivery={delivery} />
        </div>
      </CardContent>
    </Card>
  );
}
