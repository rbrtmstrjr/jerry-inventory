// Capture computePnl outputs for several ranges → baseline JSON, to prove the
// SQL-aggregated refactor produces byte-identical numbers. Run before + after.
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { computePnl } from "../lib/pnl.ts";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const url = env.NEXT_PUBLIC_SUPABASE_URL, anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const admin = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: us } = await admin.auth.admin.listUsers();
const owner = us.users.find((u) => u.email?.includes("robertmaestro"));
const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: owner.email });
const c = createClient(url, anon, { auth: { persistSession: false } });
await c.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: "email" });

const { data: shops } = await admin.from("shops").select("id").is("deleted_at", null).order("id").limit(1);
const shop1 = shops[0].id;
const today = new Date().toISOString().slice(0, 10);
const mStart = today.slice(0, 7) + "-01";
const d = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

const ranges = [
  { name: "month", from: mStart, to: today },
  { name: "week", from: d(6), to: today },
  { name: "full-year", from: d(400), to: today },
  { name: "month-oneshop", from: mStart, to: today, shopId: shop1 },
  { name: "quarter", from: d(90), to: today },
];

const out = {};
const timing = {};
for (const r of ranges) {
  const t = Date.now();
  out[r.name] = await computePnl(c, r);
  timing[r.name] = Date.now() - t;
}
const path = process.argv[2] || "pnl-baseline.json";
writeFileSync(new URL(`../${path}`, import.meta.url), JSON.stringify(out));
console.log("captured", Object.keys(out).length, "ranges →", path);
console.log("timing(ms):", JSON.stringify(timing));
