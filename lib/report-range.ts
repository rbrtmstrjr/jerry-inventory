export const MAX_REPORT_DAYS = 366;

/** Clamp a report [from,to] span to at most MAX_REPORT_DAYS. If the span is
 *  longer, move `from` up to (to - MAX_REPORT_DAYS) and flag it. Dates are
 *  "YYYY-MM-DD" (UTC). */
export function clampReportRange(from: string, to: string): { from: string; to: string; clamped: boolean } {
  const d0 = new Date(from + "T00:00:00Z").getTime();
  const d1 = new Date(to + "T00:00:00Z").getTime();
  const spanDays = Math.round((d1 - d0) / 86400000);
  if (spanDays <= MAX_REPORT_DAYS) return { from, to, clamped: false };
  const clampedFrom = new Date(d1 - MAX_REPORT_DAYS * 86400000).toISOString().slice(0, 10);
  return { from: clampedFrom, to, clamped: true };
}
