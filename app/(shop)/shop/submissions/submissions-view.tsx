"use client";

import * as React from "react";
import { format } from "date-fns";
import { MessageCircleQuestion, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { formatCentavos } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { cancelLoss, cancelSale } from "../actions";

export interface SaleSubmission {
  id: string;
  business_date: string;
  status: "pending" | "questioned" | "approved" | "rejected";
  total_centavos: number;
  owner_note: string | null;
  created_at: string;
  sale_lines: {
    description: string | null;
    qty: number;
    unit_price_centavos: number;
    line_total_centavos: number;
  }[];
}

export interface LossSubmission {
  id: string;
  business_date: string;
  status: "pending" | "questioned" | "approved" | "rejected";
  reason: "nasira" | "nawala" | "expired" | "sample" | "correction";
  qty: number;
  note: string | null;
  owner_note: string | null;
  description: string | null;
  created_at: string;
}

const STATUS_BADGE: Record<
  SaleSubmission["status"],
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  pending: { label: "Pending", variant: "secondary" },
  questioned: { label: "Questioned", variant: "outline" },
  approved: { label: "Approved", variant: "default" },
  rejected: { label: "Rejected", variant: "destructive" },
};

const REASON_LABEL: Record<LossSubmission["reason"], string> = {
  nasira: "Nasira (damaged)",
  nawala: "Nawala (missing)",
  expired: "Expired",
  sample: "Sample / libre",
  correction: "Correction",
};

function StatusBadge({ status }: { status: SaleSubmission["status"] }) {
  const s = STATUS_BADGE[status];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

export function SubmissionsView({
  sales,
  losses,
}: {
  sales: SaleSubmission[];
  losses: LossSubmission[];
}) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [cancelling, setCancelling] = React.useState<
    { kind: "sale" | "loss"; id: string } | null
  >(null);

  const pendingCount =
    sales.filter((s) => s.status === "pending" || s.status === "questioned").length +
    losses.filter((l) => l.status === "pending" || l.status === "questioned").length;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Submissions</h1>
        <p className="text-sm text-muted-foreground">
          Your shop&apos;s daily batch — {pendingCount} awaiting the owner.
        </p>
      </div>

      <Tabs defaultValue="sales">
        <TabsList>
          <TabsTrigger value="sales">Sales ({sales.length})</TabsTrigger>
          <TabsTrigger value="losses">Losses ({losses.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="sales" className="flex flex-col gap-3 pt-2">
          {sales.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No sales recorded yet.
            </p>
          )}
          {sales.map((s) => (
            <Card key={s.id}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-base tabular-nums">
                    {formatCentavos(s.total_centavos)}
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={s.status} />
                    {s.status === "pending" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Cancel sale"
                        disabled={busy === s.id}
                        onClick={() => setCancelling({ kind: "sale", id: s.id })}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                </div>
                <CardDescription>
                  {format(new Date(s.created_at), "MMM d, yyyy h:mm a")} ·{" "}
                  {s.sale_lines.length} line{s.sale_lines.length === 1 ? "" : "s"}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-1 text-sm">
                {s.sale_lines.map((l, i) => (
                  <div key={i} className="flex justify-between">
                    <span className="truncate">
                      {l.description ?? "Item"} × {l.qty}
                    </span>
                    <span className="tabular-nums">
                      {formatCentavos(l.line_total_centavos)}
                    </span>
                  </div>
                ))}
                {s.owner_note && (
                  <div className="mt-2 flex items-start gap-2 rounded-md bg-accent p-2 text-accent-foreground">
                    <MessageCircleQuestion className="mt-0.5 size-4 shrink-0" />
                    <span>Owner: {s.owner_note}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="losses" className="flex flex-col gap-3 pt-2">
          {losses.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No losses recorded yet.
            </p>
          )}
          {losses.map((l) => (
            <Card key={l.id}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-base">
                    {l.description ?? "Item"} × {l.qty}
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{REASON_LABEL[l.reason]}</Badge>
                    <StatusBadge status={l.status} />
                    {l.status === "pending" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Cancel loss"
                        disabled={busy === l.id}
                        onClick={() => setCancelling({ kind: "loss", id: l.id })}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                </div>
                <CardDescription>
                  {format(new Date(l.created_at), "MMM d, yyyy h:mm a")}
                </CardDescription>
              </CardHeader>
              {(l.note || l.owner_note) && (
                <CardContent className="flex flex-col gap-2 text-sm">
                  {l.note && <p className="text-muted-foreground">{l.note}</p>}
                  {l.owner_note && (
                    <div className="flex items-start gap-2 rounded-md bg-accent p-2 text-accent-foreground">
                      <MessageCircleQuestion className="mt-0.5 size-4 shrink-0" />
                      <span>Owner: {l.owner_note}</span>
                    </div>
                  )}
                </CardContent>
              )}
            </Card>
          ))}
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(o) => !o && setCancelling(null)}
        title={
          cancelling?.kind === "sale"
            ? "Cancel this pending sale?"
            : "Cancel this pending loss report?"
        }
        description="It disappears from the owner's queue. You can record it again anytime."
        confirmLabel="Yes, cancel it"
        destructive
        onConfirm={async () => {
          if (!cancelling) return;
          setBusy(cancelling.id);
          const res =
            cancelling.kind === "sale"
              ? await cancelSale(cancelling.id)
              : await cancelLoss(cancelling.id);
          setBusy(null);
          if (res.ok) {
            toast.success(
              cancelling.kind === "sale" ? "Sale cancelled" : "Loss report cancelled"
            );
          } else {
            toast.error(res.error);
          }
        }}
      />
    </div>
  );
}
