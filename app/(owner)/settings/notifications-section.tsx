"use client";

import { Bell, MessageSquare } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { NotificationChannelRow } from "./types";

const CHANNEL_LABEL: Record<string, string> = {
  in_app: "In-app (the bell)",
  sms: "SMS",
};

/**
 * Channel status — deliberately READ-ONLY.
 *
 * The spec allowed a toggle. Neither channel has one, and both omissions are
 * the point:
 *
 *  • SMS has no provider wired. `sms` is seeded disabled and there is no worker
 *    draining its dispatches. A switch that enables it would queue rows nothing
 *    ever sends, which is worse than no switch — the alerts would look
 *    delivered and silently go nowhere.
 *
 *  • in_app is the ONLY working channel. A switch to turn it off is a switch
 *    that turns off every alert this business runs on — low stock, overdue
 *    suppliers, expiring warranties — with no second channel to catch the fall.
 *
 * The row that matters here is `notifications` itself, which is
 * channel-independent; `fn_notify` fans out a dispatch per enabled channel. So
 * adding SMS later is "wire a provider, enable the channel, drain pending
 * dispatches" — no schema change, and this panel starts reporting it for free.
 */
export function NotificationsSection({
  channels,
  pendingCounts,
}: {
  channels: NotificationChannelRow[];
  pendingCounts: Record<string, number>;
}) {
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Delivery channels</CardTitle>
          <CardDescription>
            How an alert reaches you. The alert itself is recorded independently
            of how it&apos;s delivered, so a new channel never means new tables.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {channels.length === 0 && (
            <p className="text-sm text-muted-foreground">No channels configured.</p>
          )}
          {channels.map((c) => {
            const pending = pendingCounts[c.code] ?? 0;
            return (
              <div
                key={c.code}
                className="flex items-center justify-between gap-4 rounded-md border p-3"
              >
                <div className="flex items-start gap-3">
                  {c.code === "sms" ? (
                    <MessageSquare className="mt-0.5 size-4 text-muted-foreground" />
                  ) : (
                    <Bell className="mt-0.5 size-4 text-muted-foreground" />
                  )}
                  <div>
                    <p className="text-sm font-medium">
                      {CHANNEL_LABEL[c.code] ?? c.code}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {c.code === "in_app"
                        ? "Every alert lands in the bell in the top bar."
                        : c.code === "sms"
                          ? "Not built. Needs an SMS provider wired before it can be turned on."
                          : "—"}
                    </p>
                    {pending > 0 && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {pending} pending dispatch{pending === 1 ? "" : "es"} waiting
                        to send.
                      </p>
                    )}
                  </div>
                </div>
                {c.enabled ? (
                  <Badge>Active</Badge>
                ) : (
                  <Badge variant="secondary">Not configured</Badge>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Alert>
        <Bell className="size-4" />
        <AlertDescription>
          There is nothing to switch here yet. In-app is the only working
          channel, and turning it off would silence every alert with nothing to
          catch the fall. SMS needs a provider before a toggle would mean
          anything — until then it would queue messages nothing sends.
        </AlertDescription>
      </Alert>
    </div>
  );
}
