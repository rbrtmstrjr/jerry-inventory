"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  AlertTriangle,
  ArrowLeftRight,
  Bell,
  CalendarClock,
  CheckCheck,
  HandCoins,
  Package,
  PackageCheck,
  ShieldCheck,
  Store,
  Truck,
  Undo2,
  Wrench,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface Notification {
  id: string;
  type:
    | "master_low_stock"
    | "shop_low_stock"
    | "delivery_request"
    | "delivery_request_fulfilled"
    | "delivery_request_dismissed"
    | "utang_payment"
    | "utang_payment_voided"
    | "delivery_incoming"
    | "delivery_confirmed"
    | "delivery_discrepancy"
    | "warranty_expiring"
    | "supplier_limit_warning"
    | "supplier_limit_reached"
    | "supplier_payment_overdue"
    | "transfer_requested"
    | "transfer_approved"
    | "transfer_rejected"
    | "warranty_claim"
    | "warranty_claim_approved"
    | "warranty_claim_rejected";
  title: string;
  body: string | null;
  ref_table: string | null;
  ref_id: string | null;
  read_at: string | null;
  created_at: string;
}

/** Where each notification type takes you. */
const LINK: Record<Notification["type"], (v: "owner" | "employee") => string> = {
  master_low_stock: () => "/stock-alerts",
  shop_low_stock: (v) => (v === "owner" ? "/stock-alerts" : "/shop/low-stock"),
  delivery_request: () => "/stock-alerts?tab=requests",
  delivery_request_fulfilled: () => "/shop/low-stock",
  delivery_request_dismissed: () => "/shop/low-stock",
  utang_payment: (v) => (v === "owner" ? "/receivables" : "/shop/receivables"),
  utang_payment_voided: (v) => (v === "owner" ? "/receivables" : "/shop/receivables"),
  delivery_incoming: () => "/shop/deliveries",
  delivery_confirmed: () => "/deliveries",
  delivery_discrepancy: () => "/deliveries",
  warranty_expiring: (v) => (v === "owner" ? "/warranties" : "/shop/warranties"),
  supplier_limit_warning: () => "/suppliers?tab=payables",
  supplier_limit_reached: () => "/suppliers?tab=payables",
  supplier_payment_overdue: () => "/suppliers?tab=payables",
  transfer_requested: () => "/deliveries?tab=transfers",
  transfer_approved: () => "/shop/transfers",
  transfer_rejected: () => "/shop/transfers",
  warranty_claim: () => "/warranties",
  warranty_claim_approved: () => "/shop/warranties",
  warranty_claim_rejected: () => "/shop/warranties",
};

const ICON: Record<Notification["type"], React.ComponentType<{ className?: string }>> = {
  master_low_stock: Package,
  shop_low_stock: Store,
  delivery_request: Truck,
  delivery_request_fulfilled: Truck,
  delivery_request_dismissed: Truck,
  utang_payment: HandCoins,
  utang_payment_voided: Undo2,
  delivery_incoming: Truck,
  delivery_confirmed: PackageCheck,
  delivery_discrepancy: AlertTriangle,
  warranty_expiring: ShieldCheck,
  supplier_limit_warning: AlertTriangle,
  supplier_limit_reached: AlertTriangle,
  supplier_payment_overdue: CalendarClock,
  transfer_requested: ArrowLeftRight,
  transfer_approved: ArrowLeftRight,
  transfer_rejected: ArrowLeftRight,
  warranty_claim: Wrench,
  warranty_claim_approved: Wrench,
  warranty_claim_rejected: Wrench,
};

export function NotificationBell({ variant }: { variant: "owner" | "employee" }) {
  const router = useRouter();
  const [items, setItems] = React.useState<Notification[]>([]);
  const [open, setOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("notifications")
      .select("id, type, title, body, ref_table, ref_id, read_at, created_at")
      .order("created_at", { ascending: false })
      .limit(30);
    setItems((data ?? []) as Notification[]);
  }, []);

  React.useEffect(() => {
    load();
    const supabase = createClient();
    const channel = supabase
      .channel("notification-bell")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notifications" },
        () => load()
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [load]);

  const unread = items.filter((n) => !n.read_at).length;

  async function markRead(id: string) {
    const supabase = createClient();
    await supabase.rpc("fn_mark_notification_read", { p_id: id });
    setItems((xs) =>
      xs.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n))
    );
  }

  async function markAllRead() {
    const supabase = createClient();
    await supabase.rpc("fn_mark_all_notifications_read");
    load();
  }

  async function openItem(n: Notification) {
    if (!n.read_at) await markRead(n.id);
    setOpen(false);
    router.push(LINK[n.type]?.(variant) ?? "/");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={
            unread > 0 ? `Notifications, ${unread} unread` : "Notifications"
          }
        >
          <Bell className="size-4" />
          {unread > 0 && (
            <Badge className="absolute -right-0.5 -top-0.5 h-4 min-w-4 justify-center px-1 text-[10px] tabular-nums">
              {unread > 9 ? "9+" : unread}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">Notifications</span>
          {unread > 0 && (
            <Button variant="ghost" size="sm" onClick={markAllRead}>
              <CheckCheck className="size-3.5" /> Mark all read
            </Button>
          )}
        </div>

        <div className="thin-scrollbar max-h-96 overflow-y-auto">
          {items.length === 0 && (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              Nothing yet — stock alerts show up here.
            </p>
          )}
          {items.map((n) => {
            const Icon = ICON[n.type] ?? Bell;
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => openItem(n)}
                className={cn(
                  "flex w-full items-start gap-2.5 border-b px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-accent",
                  !n.read_at && "bg-primary/5"
                )}
              >
                <Icon
                  className={cn(
                    "mt-0.5 size-4 shrink-0",
                    n.read_at ? "text-muted-foreground" : "text-primary"
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block truncate text-sm",
                      !n.read_at && "font-medium"
                    )}
                  >
                    {n.title}
                  </span>
                  {n.body && (
                    <span className="block text-xs text-muted-foreground">
                      {n.body}
                    </span>
                  )}
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
                  </span>
                </span>
                {!n.read_at && (
                  <span
                    className="mt-1.5 size-2 shrink-0 rounded-full bg-primary"
                    aria-hidden
                  />
                )}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
