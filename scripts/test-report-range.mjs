// Pure-unit test of lib/report-range.ts#clampReportRange — no DB required.
// Run: node --experimental-strip-types scripts/test-report-range.mjs
import { clampReportRange, MAX_REPORT_DAYS } from "../lib/report-range.ts";

let passed = 0;
let failed = 0;

function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
  }
}

function addDays(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// (a) a 7-day span → clamped=false, from/to unchanged
{
  const to = "2026-07-31";
  const from = addDays(to, -6); // 7-day span inclusive
  const r = clampReportRange(from, to);
  check("7-day span: clamped=false", r.clamped === false);
  check("7-day span: from unchanged", r.from === from);
  check("7-day span: to unchanged", r.to === to);
}

// (b) exactly 366 days → clamped=false
{
  const to = "2026-07-31";
  const from = addDays(to, -MAX_REPORT_DAYS);
  const r = clampReportRange(from, to);
  check("exactly 366 days: clamped=false", r.clamped === false);
  check("exactly 366 days: from unchanged", r.from === from);
  check("exactly 366 days: to unchanged", r.to === to);
}

// (c) 400 days → clamped=true and from === to minus 366 days
{
  const to = "2026-07-31";
  const from = addDays(to, -400);
  const r = clampReportRange(from, to);
  const expectedFrom = addDays(to, -MAX_REPORT_DAYS);
  check("400-day span: clamped=true", r.clamped === true);
  check("400-day span: from === to - 366 days", r.from === expectedFrom);
  check("400-day span: to unchanged", r.to === to);
}

// (d) a 3-year span → clamped=true, resulting span is exactly 366 days
{
  const to = "2026-07-31";
  const from = addDays(to, -365 * 3);
  const r = clampReportRange(from, to);
  const d0 = new Date(r.from + "T00:00:00Z").getTime();
  const d1 = new Date(r.to + "T00:00:00Z").getTime();
  const spanDays = Math.round((d1 - d0) / 86400000);
  check("3-year span: clamped=true", r.clamped === true);
  check("3-year span: resulting span is exactly 366 days", spanDays === MAX_REPORT_DAYS);
  check("3-year span: to unchanged", r.to === to);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
