import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);

const owner = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const { data: auth, error } = await owner.auth.signInWithPassword({
  email: "owner@jerrysmarine.test",
  password: "Owner!Dev2026",
});
if (error) throw error;
console.log("signed in, setting realtime auth explicitly");
await owner.realtime.setAuth(auth.session.access_token);

const ch = owner
  .channel("rt-debug")
  .on("postgres_changes", { event: "*", schema: "public", table: "losses" }, (p) => {
    console.log("EVENT RECEIVED:", p.eventType, p.new?.note ?? "");
  })
  .subscribe((status, err) => {
    console.log("channel status:", status, err?.message ?? "");
  });

// employee inserts a loss after 3s (fixture created by owner first)
setTimeout(async () => {
  const RUN = Date.now().toString(36).toUpperCase();
  const { data: part } = await owner
    .from("parts")
    .insert({ name: `RT-DEBUG ${RUN}`, cost_centavos: 100, price_centavos: 200 })
    .select()
    .single();
  await owner.rpc("fn_receive_stock", {
    p_supplier_id: null, p_note: `RT-DEBUG ${RUN}`,
    p_parts: [{ part_id: part.id, qty: 1, unit_cost_centavos: 100 }], p_engines: [],
  });
  await owner.rpc("fn_deliver_stock", {
    p_shop_id: "a0000000-0000-4000-8000-000000000001", p_note: `RT-DEBUG ${RUN}`,
    p_parts: [{ part_id: part.id, qty: 1 }], p_engine_ids: [],
  });

  const emp = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  await emp.auth.signInWithPassword({ email: "branch1@jerrysmarine.test", password: "Branch1!Dev2026" });
  const { data, error: e2 } = await emp.rpc("fn_record_loss", {
    p_part_id: part.id, p_engine_id: null, p_qty: 1, p_reason: "correction", p_note: "RT-DEBUG ping",
  });
  console.log("insert result:", data ?? e2?.message);

  // cleanup after event window
  setTimeout(async () => {
    const now = new Date().toISOString();
    if (data) await emp.from("losses").delete().eq("id", data);
    await owner.from("stock_levels").delete().eq("part_id", part.id);
    await owner.from("receivings").update({ deleted_at: now }).like("note", "RT-DEBUG%");
    await owner.from("deliveries").update({ deleted_at: now }).like("note", "RT-DEBUG%");
    await owner.from("parts").update({ deleted_at: now }).eq("id", part.id);
    process.exit(0);
  }, 8000);
}, 3000);
