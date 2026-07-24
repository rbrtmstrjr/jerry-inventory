import type { Metadata } from "next";
import { Suspense } from "react";

import { createClient } from "@/lib/supabase/server";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { SettingsView } from "./settings-view";
import type { CronJobHealth, NotificationChannelRow } from "./types";

export const metadata: Metadata = { title: "Settings" };

/**
 * Settings is one page with six sections, deep-linked by `?tab=` — the same
 * shape /deliveries uses. Everything the owner configures lives here; nothing
 * per-shop or per-product does (shop logins stay on /shops, reorder levels on
 * /stock-alerts), because those are scoped to a thing, not to the business.
 */
/** Shell: the heading paints instantly; the six settings sections stream in
 *  behind a skeleton instead of the whole-segment loader. */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Business identity used on every printed document, your sign-in
          credentials, alert thresholds, and a read-only health check.
        </p>
      </div>
      <Suspense fallback={<SettingsSkeleton />}>
        <SettingsBody tab={tab} />
      </Suspense>
    </div>
  );
}

async function SettingsBody({ tab }: { tab?: string }) {
  const supabase = await createClient();

  const [
    { data: settings },
    { data: channels },
    { data: userRes },
    { data: cronHealth, error: cronErr },
  ] = await Promise.all([
    supabase.from("settings").select("*").eq("id", 1).single(),

    supabase.from("notification_channels").select("code, enabled").order("code"),

    supabase.auth.getUser(),

    // pg_cron lives outside the `public` schema, so PostgREST cannot read it —
    // this definer function is the only route. It returns no job command and no
    // run message: both can carry a service key.
    supabase.rpc("fn_cron_job_health"),
  ]);

  // Pending dispatches per channel. PostgREST has no GROUP BY, and there are
  // only ever a couple of channels, so a count per channel is cheaper and
  // clearer than pulling every row back to count in JS.
  const channelRows = (channels ?? []) as NotificationChannelRow[];
  const pendingCounts = Object.fromEntries(
    await Promise.all(
      channelRows.map(async (c) => {
        const { count } = await supabase
          .from("notification_dispatches")
          .select("id", { count: "exact", head: true })
          .eq("channel", c.code)
          .eq("status", "pending");
        return [c.code, count ?? 0] as const;
      })
    )
  );

  // Presence only — never the value. A boolean cannot leak a key.
  const env = {
    supabaseUrl: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    anonKey: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    serviceRoleKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  };

  return (
    <SettingsView
      initialTab={tab}
      settings={settings ?? null}
      channels={channelRows}
      pendingCounts={pendingCounts}
      account={{
        email: userRes?.user?.email ?? null,
        lastSignInAt: userRes?.user?.last_sign_in_at ?? null,
      }}
      cron={{
        jobs: (cronHealth ?? []) as CronJobHealth[],
        error: cronErr?.message ?? null,
      }}
      env={env}
    />
  );
}

function SettingsSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-24" />
        ))}
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="mt-2 h-3 w-72" />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-9 w-full max-w-md" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
