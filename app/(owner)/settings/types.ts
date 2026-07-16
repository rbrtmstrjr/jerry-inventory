/** Row shapes for the Settings sections (hand-maintained; matches migrations). */

/** The full owner-only settings row. */
export interface SettingsRow {
  id: number;
  // Business identity — printed on documents. Also exposed, and ONLY these,
  // through the `public_settings` view so shop logins can print a complete
  // receipt (0043).
  business_name: string;
  address: string | null;
  phone: string | null;
  business_email: string | null;
  business_tin: string | null;
  receipt_footer: string | null;
  // Operating dials — owner-only, never exposed to a shop.
  default_warranty_months: number;
  warranty_expiry_alert_days: number;
  supplier_limit_warn_pct: number;
  quote_stale_days: number;
  payroll_working_days_per_month: number;
  contribution_split_semimonthly: "half_each" | "second_cutoff";
}

/** Business identity as read by the six printed documents (`public_settings`). */
export interface PublicSettingsRow {
  business_name: string;
  address: string | null;
  phone: string | null;
  business_email: string | null;
  business_tin: string | null;
  receipt_footer: string | null;
}

export interface NotificationChannelRow {
  code: string;
  enabled: boolean;
}

/**
 * One pg_cron job's health, from `fn_cron_job_health()`.
 * No `command` and no run message: both can carry a service key.
 */
export interface CronJobHealth {
  jobname: string;
  schedule: string;
  active: boolean;
  last_run_at: string | null;
  last_status: string | null;
  /** active AND (never run OR last run >24h ago). The reason the panel exists. */
  stale: boolean;
}
