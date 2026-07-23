"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { HandCoins, Loader2, Plus, Undo2, Wallet } from "lucide-react";
import { toast } from "sonner";

import { formatCentavos, parsePesosToCentavos } from "@/lib/format";
import { ph_today } from "@/lib/ph-date";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ShopBadge } from "@/components/shop-badge";
import { DatePicker } from "@/components/date-picker";
import { recordStaffAdvance, voidStaffAdvance } from "../actions";

export interface StaffOption {
  id: string;
  full_name: string;
  shop_name: string | null;
  shop_color_key: string | null;
}
export interface BalanceRow {
  staff_id: string;
  full_name: string;
  advanced: number;
  deducted: number;
  balance: number;
}
export interface AdvanceRow {
  id: string;
  staff_name: string;
  shop_name: string | null;
  shop_color_key: string | null;
  amount_centavos: number;
  note: string | null;
  advance_date: string;
}

export function AdvancesView({
  staff,
  balances,
  advances,
}: {
  staff: StaffOption[];
  balances: BalanceRow[];
  advances: AdvanceRow[];
}) {
  const router = useRouter();
  const [staffId, setStaffId] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [note, setNote] = React.useState("");
  const [date, setDate] = React.useState(ph_today());
  const [busy, setBusy] = React.useState(false);
  const [voiding, setVoiding] = React.useState<AdvanceRow | null>(null);

  // Reveal the vale history in batches so a long ledger paints instantly.
  const HISTORY_PAGE = 30;
  const [visibleCount, setVisibleCount] = React.useState(HISTORY_PAGE);
  const sentinelRef = React.useRef<HTMLDivElement | null>(null);
  const visibleAdvances = advances.slice(0, visibleCount);
  React.useEffect(() => {
    const el = sentinelRef.current;
    if (!el || visibleCount >= advances.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((n) => Math.min(n + HISTORY_PAGE, advances.length));
        }
      },
      { rootMargin: "400px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visibleCount, advances.length]);

  const amountC = parsePesosToCentavos(amount || "0") ?? 0;

  async function onGive() {
    if (!staffId) {
      toast.error("Pick a staff member");
      return;
    }
    if (amountC <= 0) {
      toast.error("Enter an amount");
      return;
    }
    setBusy(true);
    const res = await recordStaffAdvance({
      staff_id: staffId,
      amount_centavos: amountC,
      note: note.trim() || null,
      advance_date: date,
    });
    setBusy(false);
    if (res.ok) {
      toast.success("Vale recorded");
      setStaffId("");
      setAmount("");
      setNote("");
      setDate(ph_today());
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {/* Give a vale */}
      <Card className="lg:col-span-1">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <HandCoins className="size-4" /> Give a vale
          </CardTitle>
          <CardDescription>
            Record cash a staffer borrowed. It builds a balance you deduct from
            their pay, period by period.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid gap-1.5">
            <Label>Staff</Label>
            <Select value={staffId} onValueChange={setStaffId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Pick a staff member…" />
              </SelectTrigger>
              <SelectContent>
                {staff.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.full_name}
                    {s.shop_name ? ` · ${s.shop_name}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="adv-amount">Amount ₱</Label>
            <Input
              id="adv-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
              placeholder="0.00"
              className="tabular-nums"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="adv-date">Date</Label>
            <DatePicker id="adv-date" value={date} onChange={setDate} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="adv-note">Note (optional)</Label>
            <Input
              id="adv-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. emergency, tuition"
            />
          </div>
          <Button onClick={onGive} disabled={busy} className="self-start">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Record vale
          </Button>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4 lg:col-span-2">
        {/* Outstanding balances */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Wallet className="size-4" /> Outstanding balances
            </CardTitle>
            <CardDescription>
              What each staffer still owes. Deduct installments on the pay period.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {balances.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No outstanding vales — everyone&apos;s settled.
              </p>
            ) : (
              <div className="flex flex-col divide-y">
                {balances.map((b) => (
                  <div
                    key={b.staff_id}
                    className="flex items-center justify-between gap-2 py-2 text-sm"
                  >
                    <div>
                      <div className="font-medium">{b.full_name}</div>
                      <div className="text-xs text-muted-foreground tabular-nums">
                        {formatCentavos(b.advanced)} advanced ·{" "}
                        {formatCentavos(b.deducted)} repaid
                      </div>
                    </div>
                    <span className="font-semibold tabular-nums text-warning-foreground">
                      {formatCentavos(b.balance)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* History */}
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Vales given</h2>
          {advances.length === 0 ? (
            <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              No vales recorded yet.
            </p>
          ) : (
            visibleAdvances.map((a) => (
              <div
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 font-medium">
                    {a.staff_name}
                    {a.shop_name && (
                      <ShopBadge
                        variant="text"
                        shop={{ name: a.shop_name, color_key: a.shop_color_key }}
                      />
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {format(new Date(a.advance_date + "T00:00:00"), "MMM d, yyyy")}
                    {a.note ? ` · ${a.note}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold tabular-nums">
                    {formatCentavos(a.amount_centavos)}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Void advance"
                    onClick={() => setVoiding(a)}
                  >
                    <Undo2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))
          )}
          {visibleCount < advances.length && (
            <div
              ref={sentinelRef}
              className="py-2 text-center text-xs text-muted-foreground"
            >
              Loading more… ({visibleAdvances.length} of {advances.length})
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={voiding !== null}
        onOpenChange={(o) => !o && setVoiding(null)}
        title="Void this vale?"
        description="Use this for a mistaken entry. It's refused if the vale has already been deducted from a payslip."
        confirmLabel="Void"
        destructive
        onConfirm={async () => {
          if (!voiding) return;
          const res = await voidStaffAdvance(voiding.id);
          if (res.ok) {
            toast.success("Vale voided");
            router.refresh();
          } else toast.error(res.error);
        }}
      />
    </div>
  );
}
