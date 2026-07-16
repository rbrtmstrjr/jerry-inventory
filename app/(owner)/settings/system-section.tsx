"use client";

import { AlertTriangle, CheckCircle2, Clock, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { CronJobHealth } from "./types";

/** Timestamps are shown in PH time — the business runs on it, so 09:00 means 09:00. */
function phDateTime(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function agoLabel(iso: string | null): string | null {
  if (!iso) return null;
  const hours = (Date.now() - new Date(iso).getTime()) / 36e5;
  if (hours < 1) return "less than an hour ago";
  if (hours < 48) return `${Math.floor(hours)} hours ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

const JOB_PURPOSE: Record<string, string> = {
  "warranty-expiry-daily":
    "Finds warranties nearing expiry and alerts you and the shop that sold the engine.",
  "supplier-overdue-daily": "Finds supplier balances past their due date and alerts you.",
};

/**
 * Read-only health. Nothing here writes, and nothing here is a secret.
 *
 * The cron table is the whole reason this panel exists: two daily jobs raise
 * the alerts this business depends on, and if either dies the alerts simply
 * stop — silently. Nobody finds out until a warranty lapses or a supplier
 * calls. A job that has not run in over 24h is therefore the loudest thing on
 * the page.
 */
export function SystemSection({
  cron,
  env,
}: {
  cron: { jobs: CronJobHealth[]; error: string | null };
  env: { supabaseUrl: boolean; anonKey: boolean; serviceRoleKey: boolean };
}) {
  const staleJobs = cron.jobs.filter((j) => j.stale);

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      {staleJobs.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>
            {staleJobs.length === 1
              ? "A scheduled job has stopped running"
              : `${staleJobs.length} scheduled jobs have stopped running`}
          </AlertTitle>
          <AlertDescription>
            {staleJobs.map((j) => j.jobname).join(", ")} last ran more than 24
            hours ago. While a job is stopped its alerts are not being raised at
            all — nothing else will tell you, which is why this check exists.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="size-4" /> Scheduled jobs
          </CardTitle>
          <CardDescription>
            Background checks that raise alerts on their own. Times shown in
            Philippine time.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {cron.error && (
            <Alert variant="destructive">
              <XCircle className="size-4" />
              <AlertDescription>
                Could not read job status: {cron.error}
              </AlertDescription>
            </Alert>
          )}

          {!cron.error && cron.jobs.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No scheduled jobs found. Both daily checks should be listed here —
              if this is empty, pg_cron is not scheduling anything and no alerts
              are being raised.
            </p>
          )}

          {cron.jobs.map((j) => {
            const ago = agoLabel(j.last_run_at);
            return (
              <div key={j.jobname} className="rounded-md border p-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-medium">{j.jobname}</p>
                    {JOB_PURPOSE[j.jobname] && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {JOB_PURPOSE[j.jobname]}
                      </p>
                    )}
                  </div>
                  {!j.active ? (
                    <Badge variant="secondary">Disabled</Badge>
                  ) : j.stale ? (
                    <Badge variant="destructive">Stale</Badge>
                  ) : (
                    <Badge>Healthy</Badge>
                  )}
                </div>
                <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
                  <div>
                    <dt className="text-muted-foreground">Schedule</dt>
                    <dd className="font-mono">{j.schedule} UTC</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Last run</dt>
                    <dd>
                      {phDateTime(j.last_run_at)}
                      {ago && <span className="text-muted-foreground"> · {ago}</span>}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Last result</dt>
                    <dd>{j.last_status ?? "—"}</dd>
                  </div>
                </dl>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connection</CardTitle>
          <CardDescription>
            Presence checks only — no key or secret is ever shown here, and
            there is nothing on this page to copy.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2">
          {/* If this component rendered at all, the page's own server-side reads
              succeeded, so the database answered. */}
          <HealthRow label="Database reachable" ok={true} okText="Connected" />
          <HealthRow label="Supabase URL configured" ok={env.supabaseUrl} />
          <HealthRow label="Public API key configured" ok={env.anonKey} />
          <HealthRow
            label="Service role key configured"
            ok={env.serviceRoleKey}
            failText="Missing — creating shop logins will fail"
          />
        </CardContent>
      </Card>
    </div>
  );
}

function HealthRow({
  label,
  ok,
  okText = "Configured",
  failText = "Missing",
}: {
  label: string;
  ok: boolean;
  okText?: string;
  failText?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border p-3">
      <span className="text-sm">{label}</span>
      <span className="flex items-center gap-2 text-xs">
        {ok ? (
          <>
            <CheckCircle2 className="size-4 text-primary" />
            <span className="text-muted-foreground">{okText}</span>
          </>
        ) : (
          <>
            <XCircle className="size-4 text-destructive" />
            <span className="text-destructive">{failText}</span>
          </>
        )}
      </span>
    </div>
  );
}
