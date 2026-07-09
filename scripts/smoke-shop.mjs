import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];

const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const { data, error } = await c.auth.signInWithPassword({
  email: "branch1@jerrysmarine.test",
  password: "Branch1!Dev2026",
});
if (error) throw new Error(error.message);
const cookie = `sb-${ref}-auth-token=base64-${Buffer.from(JSON.stringify(data.session)).toString("base64url")}`;

let fail = 0;
for (const path of ["/shop", "/shop/record-sale", "/shop/record-loss", "/shop/submissions"]) {
  const res = await fetch("http://localhost:3000" + path, { headers: { cookie }, redirect: "manual" });
  const ok = res.status === 200;
  if (!ok) fail++;
  console.log(`${ok ? "✓" : "✗"} GET ${path} → ${res.status}`);
}
process.exit(fail ? 1 : 0);
