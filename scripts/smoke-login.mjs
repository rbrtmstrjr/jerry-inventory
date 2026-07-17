/**
 * Smoke test: real sign-in â†’ role-gated pages on the running dev server.
 * Run with dev server up: node scripts/smoke-login.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
const BASE = "http://localhost:3000";

async function sessionCookie(email, password) {
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  const value = "base64-" + Buffer.from(JSON.stringify(data.session)).toString("base64url");
  // chunk like @supabase/ssr does when > 3180 chars
  const name = `sb-${ref}-auth-token`;
  if (value.length <= 3180) return `${name}=${value}`;
  const chunks = [];
  for (let i = 0; i * 3180 < value.length; i++) {
    chunks.push(`${name}.${i}=${value.slice(i * 3180, (i + 1) * 3180)}`);
  }
  return chunks.join("; ");
}

async function get(path, cookie) {
  const res = await fetch(BASE + path, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
  const body = res.status === 200 ? await res.text() : "";
  return { status: res.status, location: res.headers.get("location"), body };
}

let fail = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "âœ“" : "âœ—"} ${name} ${ok ? "" : detail}`);
  if (!ok) fail++;
}

const ownerCookie = await sessionCookie("robertmaestro09@gmail.com", "rajonrondo09");
const empCookie = await sessionCookie("branch1@jerrysmarine.test", "Branch1!Dev2026");

console.log("Owner session:");
let r = await get("/dashboard", ownerCookie);
check("GET /dashboard â†’ 200", r.status === 200, `got ${r.status}`);
check("dashboard renders owner shell", r.body.includes("Master Inventory"));
r = await get("/shop", ownerCookie);
check("GET /shop â†’ redirected to owner area", r.status === 307 && r.location?.includes("/dashboard"), `got ${r.status} ${r.location}`);
r = await get("/", ownerCookie);
check("GET / â†’ /dashboard", r.status === 307 && r.location?.includes("/dashboard"), `got ${r.status} ${r.location}`);

console.log("Employee session:");
r = await get("/shop", empCookie);
check("GET /shop â†’ 200", r.status === 200, `got ${r.status}`);
check("shop shell shows branch name", r.body.includes("Branch 1"), "(no branch name)");
check("employee page has NO owner nav", !r.body.includes("Master Inventory"));
r = await get("/dashboard", empCookie);
check("GET /dashboard â†’ redirected to /shop", r.status === 307 && r.location?.includes("/shop"), `got ${r.status} ${r.location}`);

console.log("Signed out:");
r = await get("/dashboard");
check("GET /dashboard â†’ /login", r.status === 307 && r.location?.includes("/login"), `got ${r.status} ${r.location}`);

console.log(fail === 0 ? "\nALL SMOKE TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
