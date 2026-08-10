import type { Metadata } from "next";
import { Suspense } from "react";

import { requirePrimaryOwner } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AdminAccountRow } from "./admin-accounts-section";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { SettingsView } from "./settings-view";
import type { CronJobHealth, NotificationChannelRow } from "./types";

export const metadata: Metadata = { title: "Settings" };

/** Six sections deep-linked by `?tab=`. Business-wide config only — anything
 *  scoped to a shop or product lives on that thing's own page. */
/** Shell: the heading paints instantly; the six settings sections stream in
 *  behind a skeleton instead of the whole-segment loader. */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  await requirePrimaryOwner(); // Gerry-only (0099): credentials + business config
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

    // pg_cron lives outside `public`, so this definer function is the only
    // route. It returns no command and no run message — both can carry a key.
    supabase.rpc("fn_cron_job_health"),
  ]);

  // PostgREST has no GROUP BY and there are only ever a couple of channels, so
  // a count per channel beats pulling every row back to count in JS.
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

  // Emails live in auth, not on the profile, so the service role resolves them.
  // This only ever renders for Gerry (requirePrimaryOwner above).
  const service = createAdminClient();
  const { data: adminProfiles } = await service
    .from("profiles")
    .select("id, full_name, active")
    .eq("role", "admin")
    .order("full_name");
  const admins: AdminAccountRow[] = await Promise.all(
    (adminProfiles ?? []).map(async (p) => {
      const { data } = await service.auth.admin.getUserById(p.id);
      return {
        id: p.id,
        full_name: p.full_name,
        active: p.active,
        email: data?.user?.email ?? null,
        last_sign_in_at: data?.user?.last_sign_in_at ?? null,
      };
    })
  );

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
      admins={admins}
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
