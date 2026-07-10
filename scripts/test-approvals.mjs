/**
 * Deliverable 6 verification — approve → deduct, warranty auto-create,
 * negative-stock guard, question/reject flow, Realtime publication.
 * Run: node scripts/test-approvals.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);

const SHOP1 = "a0000000-0000-4000-8000-000000000001";
const RUN = Date.now().toString(36).toUpperCase();
const SERIAL = `APR-TEST-${RUN}`;

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name} ${ok ? "" : detail}`);
  ok ? pass++ : fail++;
};

async function signIn(email, password) {
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return c;
}

const owner = await signIn("owner@jerrysmarine.test", "Owner!Dev2026");
const emp1 = await signIn("branch1@jerrysmarine.test", "Branch1!Dev2026");

const shopQty = async (partId) =>
  (await owner.from("stock_levels").select("qty").eq("part_id", partId).eq("shop_id", SHOP1).maybeSingle()).data?.qty ?? 0;

console.log("Setup: 5 gaskets (cost ₱90 / price ₱180) + engine at Branch 1");
const { data: cat } = await owner.from("product_categories").select("id").eq("name", "Engine Parts").single();
const { data: part } = await owner.from("parts")
  .insert({ name: `APR-TEST Gasket ${RUN}`, category_id: cat.id, cost_centavos: 9000, price_centavos: 18000 })
  .select().single();
const { data: model } = await owner.from("engine_models")
  .select("id, default_warranty_months").eq("model", "BF20DK2").single();
await owner.rpc("fn_receive_stock", {
  p_supplier_id: null, p_note: `APR-TEST setup ${RUN}`,
  p_parts: [{ part_id: part.id, qty: 5, unit_cost_centavos: 9000 }],
  p_engines: [{ serial_number: SERIAL, engine_model_id: model.id, condition: "brand_new", cost_centavos: 6_000_000, price_centavos: 7_500_000, warranty_months: null }],
});
const { data: engine } = await owner.from("engines").select("id").eq("serial_number", SERIAL).single();
const { error: dErr } = await owner.rpc("fn_deliver_stock", {
  p_shop_id: SHOP1, p_note: `APR-TEST delivery ${RUN}`,
  p_parts: [{ part_id: part.id, qty: 5 }], p_engine_ids: [engine.id],
});
check("fixtures at Branch 1 (5 pcs + engine)", !dErr && (await shopQty(part.id)) === 5, dErr?.message);

console.log("\nEmployee records: sale (2 gaskets + engine), loss (1 nasira), over-sale (4)");
const { data: saleId } = await emp1.rpc("fn_record_sale", {
  p_customer_id: null, p_customer: { name: `APR-TEST Aling Nena ${RUN}` },
  p_part_lines: [{ part_id: part.id, qty: 2 }], p_engine_ids: [engine.id],
});
const { data: lossId } = await emp1.rpc("fn_record_loss", {
  p_part_id: part.id, p_engine_id: null, p_qty: 1, p_reason: "nasira", p_note: "APR-TEST basag",
});
const { data: overSaleId } = await emp1.rpc("fn_record_sale", {
  p_customer_id: null, p_customer: null,
  p_part_lines: [{ part_id: part.id, qty: 4 }], p_engine_ids: [],
});
check("three submissions recorded", !!saleId && !!lossId && !!overSaleId);
{
  // new batch flow: recorded items must be submitted before the owner sees them
  const { data, error } = await emp1.rpc("fn_submit_shop_batch");
  check("batch submitted to owner (2 sales + 1 loss)", !error && data?.sales === 2 && data?.losses === 1, error?.message);
}

console.log("\nSecurity: employee cannot approve");
{
  const { error } = await emp1.rpc("fn_approve_sale", { p_sale_id: saleId, p_note: null });
  check("employee approve rejected", !!error && /owner/i.test(error.message));
}

console.log("\nApprove sale (2 gaskets + engine):");
{
  const { error } = await owner.rpc("fn_approve_sale", { p_sale_id: saleId, p_note: null });
  check("fn_approve_sale succeeded", !error, error?.message);
}
check("shop stock 5 → 3", (await shopQty(part.id)) === 3, `(got ${await shopQty(part.id)})`);
{
  const { data: s } = await owner.from("sales").select("status, reviewed_at").eq("id", saleId).single();
  check("sale status approved + reviewed_at set", s?.status === "approved" && !!s?.reviewed_at);
}
{
  const { data: e } = await owner.from("engines").select("status, customer_id, sold_at").eq("id", engine.id).single();
  check("engine sold + customer + sold_at", e?.status === "sold" && !!e?.customer_id && !!e?.sold_at);
}
{
  const { data: w } = await owner.from("warranties")
    .select("months, sold_on, expires_on, customer_id, sale_id").eq("engine_id", engine.id).single();
  check("warranty auto-created", !!w);
  check(`warranty months = model default (${model.default_warranty_months})`, w?.months === model.default_warranty_months);
  if (w) {
    const expected = new Date(w.sold_on + "T00:00:00Z");
    expected.setUTCMonth(expected.getUTCMonth() + w.months);
    const expectedStr = expected.toISOString().slice(0, 10);
    check(`warranty expires ${expectedStr}`, w.expires_on === expectedStr, `(got ${w.expires_on})`);
    check("warranty linked to sale + customer", w.sale_id === saleId && !!w.customer_id);
  }
}
{
  const { data: moves } = await owner.from("stock_movements").select("*").eq("sale_id", saleId);
  check("ledger: 2 sale rows (part −2, engine −1) at shop", moves?.length === 2 &&
    moves.every((m) => m.shop_id === SHOP1 && m.movement_type === "sale"));
}
{
  const { error } = await owner.rpc("fn_approve_sale", { p_sale_id: saleId, p_note: null });
  check("double-approve rejected", !!error && /already reviewed/i.test(error.message));
}

console.log("\nApprove loss (1 nasira):");
{
  const { error } = await owner.rpc("fn_approve_loss", { p_loss_id: lossId, p_note: null });
  check("fn_approve_loss succeeded", !error, error?.message);
}
check("shop stock 3 → 2", (await shopQty(part.id)) === 2);
{
  const { data: l } = await owner.from("losses").select("status, value_centavos").eq("id", lossId).single();
  check("loss approved, valued at cost (₱90)", l?.status === "approved" && l?.value_centavos === 9000, `(got ${l?.value_centavos})`);
}

console.log("\nNegative-stock guard (approve 4 when only 2 left):");
{
  const { error } = await owner.rpc("fn_approve_sale", { p_sale_id: overSaleId, p_note: null });
  check("guard blocks approval", !!error && /negative/i.test(error.message), error?.message);
  const { data: s } = await owner.from("sales").select("status").eq("id", overSaleId).single();
  check("over-sale still pending (nothing partial)", s?.status === "pending");
  check("stock unchanged (still 2)", (await shopQty(part.id)) === 2);
}

console.log("\nQuestion → employee sees note → reject:");
{
  const { error } = await owner.rpc("fn_review_submission", {
    p_kind: "sale", p_id: overSaleId, p_action: "question", p_note: "APR-TEST Bakit apat? Dalawa na lang natira.",
  });
  check("question sent", !error, error?.message);
  const { data: s } = await emp1.from("sales").select("status, owner_note").eq("id", overSaleId).single();
  check("employee sees questioned + note", s?.status === "questioned" && /Bakit/.test(s?.owner_note ?? ""));
}
{
  const { error } = await owner.rpc("fn_review_submission", {
    p_kind: "sale", p_id: overSaleId, p_action: "reject", p_note: "APR-TEST Hindi tama ang bilang.",
  });
  check("reject after question works", !error, error?.message);
  const { data: s } = await owner.from("sales").select("status, reviewed_at").eq("id", overSaleId).single();
  check("sale rejected + reviewed_at", s?.status === "rejected" && !!s?.reviewed_at);
  check("stock still 2 (rejection moves nothing)", (await shopQty(part.id)) === 2);
}
{
  const { error } = await owner.rpc("fn_review_submission", {
    p_kind: "sale", p_id: overSaleId, p_action: "question", p_note: "too late",
  });
  check("cannot question a rejected sale", !!error && /already reviewed/i.test(error.message));
}

console.log("\nRealtime publication:");
{
  // verify via the browser-facing realtime: check publication includes tables
  const probe = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { data: probeAuth } = await probe.auth.signInWithPassword({
    email: "owner@jerrysmarine.test",
    password: "Owner!Dev2026",
  });
  // node scripts must set realtime auth explicitly (browsers do it automatically)
  await probe.realtime.setAuth(probeAuth.session.access_token);
  const received = new Promise((resolve) => {
    const ch = probe
      .channel("test-approvals-rt")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "losses" }, (payload) => {
        resolve(payload.new?.note ?? true);
        probe.removeChannel(ch);
      })
      .subscribe();
  });
  // give the socket a moment, then trigger an insert as the employee
  await new Promise((r) => setTimeout(r, 2500));
  await emp1.rpc("fn_record_loss", {
    p_part_id: part.id, p_engine_id: null, p_qty: 1, p_reason: "correction", p_note: `APR-TEST realtime ping ${RUN}`,
  });
  const result = await Promise.race([
    received,
    new Promise((r) => setTimeout(() => r(null), 10000)),
  ]);
  check("owner receives INSERT push over Realtime", result !== null, "(no event within 10s)");
  await probe.auth.signOut();
}

console.log("\nCleanup:");
{
  const now = new Date().toISOString();
  await emp1.from("losses").delete().like("note", "APR-TEST realtime%"); // pending, own
  const r1 = await owner.from("receivings").update({ deleted_at: now }).like("note", "APR-TEST%");
  const r2 = await owner.from("deliveries").update({ deleted_at: now }).like("note", "APR-TEST%");
  const r3 = await owner.from("sales").update({ deleted_at: now }).in("id", [saleId, overSaleId]);
  const r4 = await owner.from("losses").update({ deleted_at: now }).eq("id", lossId);
  const r5 = await owner.from("warranties").update({ deleted_at: now }).eq("engine_id", engine.id);
  const r6 = await owner.from("engines").update({ deleted_at: now }).eq("id", engine.id);
  await owner.from("stock_levels").delete().eq("part_id", part.id);
  const r7 = await owner.from("parts").update({ deleted_at: now }).eq("id", part.id);
  const r8 = await owner.from("customers").update({ deleted_at: now }).like("name", "APR-TEST%");
  const err = r1.error ?? r2.error ?? r3.error ?? r4.error ?? r5.error ?? r6.error ?? r7.error ?? r8.error;
  check("fixtures cleaned", !err, err?.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
