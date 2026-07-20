"use client";

import * as React from "react";
import Link from "next/link";
import { format } from "date-fns";
import {
  ArrowRight,
  Loader2,
  Printer,
  Receipt,
  ShieldCheck,
  User,
} from "lucide-react";

import { formatCentavos } from "@/lib/format";
import type { ShopOption } from "@/lib/db-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ShopBadge } from "@/components/shop-badge";
import { ReceiptImage } from "@/components/receipt-image";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { getReviewedDetail, type ReviewedDetail } from "./history-actions";
import { STATUS_META, TypeBadge, type ReviewedItemRow } from "./reviewed-history";

const REASON_LABEL: Record<string, string> = {
  nasira: "Nasira (damaged)",
  nawala: "Nawala (missing)",
  expired: "Expired",
  sample: "Sample / libre",
  correction: "Correction",
};

/** Small labelled block used throughout the drawer. */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 border-t pt-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * Right-side drawer for one reviewed item. Driven entirely by the `item` URL
 * param ("<type>:<id>") so refreshing or sharing the link reopens the same
 * item. Radix Sheet gives focus trapping, Esc and overlay-click for free.
 */
export function ReviewedDetailSheet({
  openItem,
  shops,
  onClose,
}: {
  openItem: string | null;
  shops: ShopOption[];
  onClose: () => void;
}) {
  const [detail, setDetail] = React.useState<ReviewedDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!openItem) {
      setDetail(null);
      setError(null);
      return;
    }
    const [type, id] = openItem.split(":");
    if (!type || !id) {
      setError("Bad link");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    setError(null);
    getReviewedDetail(type, id).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (res.ok) setDetail(res.detail);
      else setError(res.error);
    });
    return () => {
      cancelled = true;
    };
  }, [openItem]);

  const itemType = (openItem?.split(":")[0] ?? "sale") as ReviewedItemRow["item_type"];

  return (
    <Sheet open={!!openItem} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-lg"
      >
        <SheetHeader className="pb-0">
          <SheetTitle className="flex items-center gap-2">
            <TypeBadge type={itemType} />
            {detail && (
              <Badge variant={STATUS_META[detail.status as "approved"]?.variant ?? "outline"}>
                {STATUS_META[detail.status as "approved"]?.label ?? detail.status}
              </Badge>
            )}
          </SheetTitle>
          <SheetDescription>
            {detail ? (
              <>
                {/* detail carries shop_name only — resolve the color by name */}
                <ShopBadge
                  variant="text"
                  shop={{
                    name: detail.shop_name,
                    color_key:
                      shops.find((s) => s.name === detail.shop_name)?.color_key ?? null,
                  }}
                />{" "}
                · {format(new Date(detail.created_at), "MMM d, yyyy h:mm a")}
              </>
            ) : (
              "Loading…"
            )}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 px-4 pb-8">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading detail…
            </div>
          )}
          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </p>
          )}

          {detail?.type === "sale" && <SaleBody d={detail} />}
          {detail?.type === "loss" && <LossBody d={detail} />}
          {detail?.type === "utang_payment" && <PaymentBody d={detail} />}
          {detail?.type === "expense" && <ExpenseBody d={detail} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function WhoWhen({
  recordedBy,
  reviewedBy,
  reviewedAt,
  batchAt,
  ownerNote,
}: {
  recordedBy: string;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  batchAt?: string | null;
  ownerNote?: string | null;
}) {
  return (
    <Section title="Who & when">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Recorded by">{recordedBy}</Field>
        <Field label="Reviewed by">
          {reviewedBy ?? <span className="text-muted-foreground">—</span>}
        </Field>
        <Field label="Reviewed at">
          {reviewedAt ? (
            format(new Date(reviewedAt), "MMM d, yyyy h:mm a")
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </Field>
        <Field label="Submitted in batch">
          {batchAt ? (
            format(new Date(batchAt), "MMM d, h:mm a")
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </Field>
      </div>
      {ownerNote && (
        <p className="rounded-md bg-accent p-2 text-sm text-accent-foreground">
          Your note: {ownerNote}
        </p>
      )}
    </Section>
  );
}

function Movements({
  movements,
}: {
  movements: { movement_type: string; qty_change: number; at: string; where: string; item: string }[];
}) {
  return (
    <Section title="Resulting stock movements">
      {movements.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No stock moved (nothing was approved).
        </p>
      ) : (
        <div className="flex flex-col gap-1 text-xs">
          {movements.map((m, i) => (
            <div key={i} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5">
              <span className="min-w-0 truncate">
                <Badge variant="outline" className="mr-1.5">
                  {m.movement_type}
                </Badge>
                {m.item}
              </span>
              <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                <span>{m.where}</span>
                <span
                  className={`font-semibold tabular-nums ${
                    m.qty_change < 0 ? "text-destructive" : "text-success"
                  }`}
                >
                  {m.qty_change > 0 ? `+${m.qty_change}` : m.qty_change}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function SaleBody({ d }: { d: Extract<ReviewedDetail, { type: "sale" }> }) {
  const isPartial = d.payment_type === "partial";
  return (
    <>
      <WhoWhen
        recordedBy={d.recorded_by}
        reviewedBy={d.reviewed_by}
        reviewedAt={d.reviewed_at}
        batchAt={d.batch_submitted_at}
        ownerNote={d.owner_note}
      />

      <Section title="Items">
        <div className="flex flex-col gap-2">
          {d.lines.map((l, i) => (
            <div key={i} className="flex flex-col gap-1 rounded-md border p-2.5">
              <div className="flex justify-between gap-2">
                <span className="min-w-0 text-sm font-medium">
                  {l.is_engine && (
                    <Badge variant="secondary" className="mr-1">
                      Engine
                    </Badge>
                  )}
                  {l.description}
                </span>
                <span className="shrink-0 font-medium tabular-nums">
                  {formatCentavos(l.line_total_centavos)}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                {l.qty} × {formatCentavos(l.unit_price_centavos)}
                {l.serial_number && (
                  <span className="ml-2 font-mono">SN {l.serial_number}</span>
                )}
                {l.model && <span className="ml-2">{l.model}</span>}
              </div>

              {/* Negotiated pricing context (engines) */}
              {l.is_engine && l.agreed_price_centavos != null && (
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 rounded-md bg-muted/50 p-2 text-xs">
                  {l.list_reference_centavos != null && (
                    <span>Asking {formatCentavos(l.list_reference_centavos)}</span>
                  )}
                  <span className="font-medium">
                    Agreed {formatCentavos(l.agreed_price_centavos)}
                  </span>
                  {l.floor_centavos != null && (
                    <span>Floor {formatCentavos(l.floor_centavos)}</span>
                  )}
                  {l.discount_centavos != null && l.discount_centavos > 0 && (
                    <span className="text-warning-foreground">
                      {formatCentavos(l.discount_centavos)} off
                    </span>
                  )}
                </div>
              )}
              {l.cost_centavos != null && l.cost_centavos > 0 && (
                <div className="text-xs text-muted-foreground">
                  <span className="font-medium">Owner-only:</span> cost{" "}
                  {formatCentavos(l.cost_centavos)} · margin{" "}
                  {formatCentavos(l.line_total_centavos - l.cost_centavos * l.qty)}
                </div>
              )}
            </div>
          ))}
        </div>
      </Section>

      <Section title="Money">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Total">
            <span className="font-semibold tabular-nums">
              {formatCentavos(d.total_centavos)}
            </span>
          </Field>
          <Field label="Payment">
            {isPartial ? "Partial (utang)" : "Paid in full"}
          </Field>
          {isPartial && (
            <>
              <Field label="Downpayment">
                <span className="tabular-nums">
                  {formatCentavos(d.amount_paid_centavos ?? 0)}
                </span>
              </Field>
              <Field label="Balance at sale">
                <span className="tabular-nums text-warning-foreground">
                  {formatCentavos(d.balance_due_centavos)}
                </span>
              </Field>
            </>
          )}
          <Field label="Customer">
            {d.customer ? (
              <span className="flex items-center gap-1">
                <User className="size-3.5 text-muted-foreground" />
                {d.customer.name}
                {d.customer.phone && (
                  <span className="text-muted-foreground">· {d.customer.phone}</span>
                )}
              </span>
            ) : (
              <span className="text-muted-foreground">Walk-in</span>
            )}
          </Field>
          <Field label="Receipt no">
            <span className="font-mono">{d.receipt_no ?? "—"}</span>
          </Field>
        </div>
      </Section>

      <Section title="Documents">
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/receipt/${d.id}`} target="_blank">
              <Receipt className="size-3.5" /> Receipt
              <Printer className="size-3.5" />
            </Link>
          </Button>
          {d.warranty_id && (
            <Button asChild variant="outline" size="sm">
              <Link href={`/warranties/${d.warranty_id}/certificate`} target="_blank">
                <ShieldCheck className="size-3.5" /> Warranty certificate
              </Link>
            </Button>
          )}
        </div>
      </Section>

      <Movements movements={d.movements} />
    </>
  );
}

function LossBody({ d }: { d: Extract<ReviewedDetail, { type: "loss" }> }) {
  return (
    <>
      <WhoWhen
        recordedBy={d.recorded_by}
        reviewedBy={d.reviewed_by}
        reviewedAt={d.reviewed_at}
        batchAt={d.batch_submitted_at}
        ownerNote={d.owner_note}
      />

      <Section title="What was lost">
        <div className="rounded-md border p-2.5">
          <div className="flex justify-between gap-2">
            <span className="font-medium">
              {d.description} × {d.qty}
            </span>
            <Badge variant="outline">{REASON_LABEL[d.reason] ?? d.reason}</Badge>
          </div>
          {d.serial_number && (
            <div className="mt-1 font-mono text-xs text-muted-foreground">
              SN {d.serial_number}
            </div>
          )}
          {d.note && (
            <p className="mt-2 text-sm text-muted-foreground">“{d.note}”</p>
          )}
        </div>
        <Field label="Written-off value (at cost)">
          <span className="font-semibold tabular-nums">
            {d.value_centavos != null
              ? formatCentavos(d.value_centavos)
              : "— (not approved)"}
          </span>
        </Field>
      </Section>

      <Movements movements={d.movements} />
    </>
  );
}

const METHOD_LABEL: Record<string, string> = {
  cash: "Cash",
  gcash: "GCash",
  bank: "Bank",
  other: "Other",
};

function ExpenseBody({ d }: { d: Extract<ReviewedDetail, { type: "expense" }> }) {
  return (
    <>
      <WhoWhen
        recordedBy={d.recorded_by}
        reviewedBy={d.approved_by}
        reviewedAt={d.approved_at}
        batchAt={d.batch_submitted_at}
        ownerNote={d.review_note}
      />

      <Section title="Expense">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount">
            <span className="text-base font-semibold tabular-nums">
              {formatCentavos(d.amount_centavos)}
            </span>
          </Field>
          <Field label="Category">
            {d.category_proposed ? (
              <Badge
                variant="outline"
                className="border-warning/50 bg-warning/10 text-warning-foreground"
              >
                proposed: {d.category_name}
              </Badge>
            ) : (
              <Badge variant="secondary">{d.category_name}</Badge>
            )}
          </Field>
          <Field label="Expense date">
            {format(new Date(d.expense_date), "MMM d, yyyy")}
          </Field>
          <Field label="Paid to">
            {d.paid_to ?? <span className="text-muted-foreground">—</span>}
          </Field>
          <Field label="Method">
            {d.payment_method ? (
              METHOD_LABEL[d.payment_method] ?? d.payment_method
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Field>
          <Field label="OR / Ref no">
            {d.reference_no ? (
              <span className="font-mono">{d.reference_no}</span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Field>
        </div>
        <p className="rounded-md border p-2.5 text-sm">{d.description}</p>
        <p className="text-xs text-muted-foreground">
          No stock moved — an expense is cash out, not inventory. It counts in
          expenses and P&amp;L only when approved.
        </p>
      </Section>

      {d.receipt_image_path && (
        <Section title="Receipt">
          <ReceiptImage
            path={d.receipt_image_path}
            className="max-h-80 w-full"
          />
        </Section>
      )}
    </>
  );
}

function PaymentBody({ d }: { d: Extract<ReviewedDetail, { type: "utang_payment" }> }) {
  return (
    <>
      <Section title="Who & when">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Recorded by">{d.recorded_by}</Field>
          <Field label="Collected at">
            {format(new Date(d.created_at), "MMM d, yyyy h:mm a")}
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">
          Utang payments post on record — they don&apos;t go through the approval
          queue.
        </p>
      </Section>

      <Section title="Payment">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount">
            <span className="text-base font-semibold tabular-nums text-success">
              {formatCentavos(d.amount_centavos)}
            </span>
          </Field>
          <Field label="Customer">
            {d.customer ? (
              <span className="flex items-center gap-1">
                <User className="size-3.5 text-muted-foreground" />
                {d.customer.name}
              </span>
            ) : (
              <span className="text-muted-foreground">Walk-in</span>
            )}
          </Field>
        </div>

        {/* The effect of THIS payment specifically */}
        <div className="flex items-center justify-center gap-3 rounded-md bg-muted/50 p-3">
          <div className="text-center">
            <div className="text-[11px] uppercase text-muted-foreground">Before</div>
            <div className="font-semibold tabular-nums">
              {formatCentavos(d.balance_before_centavos)}
            </div>
          </div>
          <ArrowRight className="size-4 text-muted-foreground" />
          <div className="text-center">
            <div className="text-[11px] uppercase text-muted-foreground">After</div>
            <div
              className={`font-semibold tabular-nums ${
                d.balance_after_centavos <= 0 ? "text-success" : "text-warning-foreground"
              }`}
            >
              {formatCentavos(Math.max(0, d.balance_after_centavos))}
            </div>
          </div>
          {d.balance_after_centavos <= 0 && (
            <Badge variant="default" className="ml-1">
              Settled
            </Badge>
          )}
        </div>
        {d.note && <p className="text-sm text-muted-foreground">“{d.note}”</p>}
      </Section>

      {d.sale && (
        <Section title="Originating sale">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2.5">
            <div className="min-w-0">
              <div className="text-sm font-medium">
                {formatCentavos(d.sale.total_centavos)} sale
              </div>
              <div className="font-mono text-xs text-muted-foreground">
                {d.sale.receipt_no ?? d.sale.id.slice(0, 8)}
              </div>
            </div>
            <div className="flex gap-2">
              <Button asChild variant="outline" size="sm">
                <Link href={`?item=sale:${d.sale.id}`} scroll={false}>
                  Open sale
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href={`/receipt/${d.sale.id}`} target="_blank">
                  <Receipt className="size-3.5" /> Receipt
                </Link>
              </Button>
            </div>
          </div>
        </Section>
      )}
    </>
  );
}
