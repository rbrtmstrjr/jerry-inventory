"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { BusinessSection } from "./business-section";
import { AccountSection } from "./account-section";
import { AlertsSection } from "./alerts-section";
import { NotificationsSection } from "./notifications-section";
import { SystemSection } from "./system-section";
import type { CronJobHealth, NotificationChannelRow, SettingsRow } from "./types";

const TAB_VALUES = [
  "business",
  "account",
  "alerts",
  "notifications",
  "system",
] as const;
type TabValue = (typeof TAB_VALUES)[number];

const TAB_LABEL: Record<TabValue, string> = {
  business: "Business",
  account: "Account",
  alerts: "Alerts",
  notifications: "Notifications",
  system: "System",
};

export function SettingsView({
  initialTab,
  settings,
  channels,
  pendingCounts,
  account,
  cron,
  env,
}: {
  initialTab?: string;
  settings: SettingsRow | null;
  channels: NotificationChannelRow[];
  pendingCounts: Record<string, number>;
  account: { email: string | null; lastSignInAt: string | null };
  cron: { jobs: CronJobHealth[]; error: string | null };
  env: { supabaseUrl: boolean; anonKey: boolean; serviceRoleKey: boolean };
}) {
  const router = useRouter();

  const [tab, setTab] = React.useState<TabValue>(() =>
    initialTab && TAB_VALUES.includes(initialTab as TabValue)
      ? (initialTab as TabValue)
      : "business"
  );

  // Keep the URL in step so a section can be linked, bookmarked and reloaded.
  // `replace`, not `push`: flicking through tabs should not stack up history
  // entries the back button then has to walk out of.
  function onTabChange(v: string) {
    setTab(v as TabValue);
    router.replace(`/settings?tab=${v}`, { scroll: false });
  }

  return (
    <Tabs value={tab} onValueChange={onTabChange}>
      <TabsList>
        {TAB_VALUES.map((v) => (
          <TabsTrigger key={v} value={v}>
            {TAB_LABEL[v]}
          </TabsTrigger>
        ))}
      </TabsList>

      {/* One read failure, one honest message — rather than each section
          rendering invented defaults. A guessed business name would print. */}
      {!settings && tab !== "account" && tab !== "system" && (
        <Alert variant="destructive" className="mt-4">
          <AlertTriangle className="size-4" />
          <AlertDescription>
            Could not read the settings row. Nothing is shown here rather than
            showing defaults that are not what the system is actually using.
          </AlertDescription>
        </Alert>
      )}

      <TabsContent value="business" className="mt-4">
        {settings && <BusinessSection settings={settings} />}
      </TabsContent>

      <TabsContent value="account" className="mt-4">
        <AccountSection email={account.email} lastSignInAt={account.lastSignInAt} />
      </TabsContent>

      <TabsContent value="alerts" className="mt-4">
        {settings && <AlertsSection settings={settings} />}
      </TabsContent>

      <TabsContent value="notifications" className="mt-4">
        <NotificationsSection channels={channels} pendingCounts={pendingCounts} />
      </TabsContent>

      <TabsContent value="system" className="mt-4">
        <SystemSection cron={cron} env={env} />
      </TabsContent>
    </Tabs>
  );
}
