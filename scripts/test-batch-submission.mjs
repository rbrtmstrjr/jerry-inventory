/**
 * Batch-submission verification — sales/losses save as RECORDED (invisible
 * to the owner's queue), the employee batches them to pending with
 * fn_submit_shop_batch at a moment of their choosing, then the owner approves.
 * Run: node scripts/test-batch-submission.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);

const SHOP2 = "a0000000-0000-4000-8000-000000000002";
const RUN = Date.now().toString(36).toUpperCase();
const SERIAL = `BATCH-TEST-${RUN}`;

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
const emp2 = await signIn("branch2@jerrysmarine.test", "Branch2!Dev2026");

const shopQty = async (partId) =>
  (await owner.from("stock_levels").select("qty").eq("part_id", partId).eq("shop_id", SHOP2).maybeSingle()).data?.qty ?? 0;

// which of our fixture ids sit in the owner's queue (pending/questioned)?
const inOwnerQueue = async (ids) =>
  (await owner.from("sales").select("id").in("id", ids).in("status", ["pending", "questioned"]).is("deleted_at", null)).data?.length ?? 0;

console.log("Setup: 10 filters (₱120) + engine delivered to Branch 2");
const { data: cat } = await owner.from("product_categories").select("id").eq("name", "Engine Parts").single();
const { data: part } = await owner.from("parts")
  .insert({ name: `BATCH-TEST Fuel Filter ${RUN}`, category_id: cat.id, cost_centavos: 6000, price_centavos: 12000 })
  .select().single();
const { data: model } = await owner.from("engine_models").select("id").eq("model", "15MH").single();
await owner.rpc("fn_receive_stock", {
  p_supplier_id: null, p_note: `BATCH-TEST setup ${RUN}`,
  p_parts: [{ part_id: part.id, qty: 10, unit_cost_centavos: 6000 }],
  p_engines: [{ serial_number: SERIAL, engine_model_id: model.id, condition: "brand_new", cost_centavos: 3_000_000, price_centavos: 3_800_000, warranty_months: null }],
});
const { data: engine } = await owner.from("engines").select("id").eq("serial_number", SERIAL).single();
const { error: dErr } = await owner.rpc("fn_deliver_stock", {
  p_shop_id: SHOP2, p_note: `BATCH-TEST delivery ${RUN}`,
  p_parts: [{ part_id: part.id, qty: 10 }], p_engine_ids: [engine.id],
});
check("fixtures at Branch 2 (10 pcs + engine)", !dErr && (await shopQty(part.id)) === 10, dErr?.message);

console.log("\nRecord: 2 sales + 1 loss — all should save as RECORDED");
const { data: saleA, error: eA } = await emp2.rpc("fn_record_sale", {
  p_customer_id: null, p_customer: null,
  p_part_lines: [{ part_id: part.id, qty: 2 }], p_engine_ids: [],
});
const { data: saleB, error: eB } = await emp2.rpc("fn_record_sale", {
  p_customer_id: null, p_customer: { name: `BATCH-TEST Ka Pedro ${RUN}` },
  p_part_lines: [], p_engine_ids: [engine.id],
});
const { data: lossId, error: eL } = await emp2.rpc("fn_record_loss", {
  p_part_id: part.id, p_engine_id: null, p_qty: 1, p_reason: "nasira", p_note: `BATCH-TEST basag ${RUN}`,
});
check("all three recorded without error", !eA && !eB && !eL, eA?.message ?? eB?.message ?? eL?.message);
{
  const { data: rows } = await emp2.from("sales").select("id, status").in("id", [saleA, saleB]);
  const { data: l } = await emp2.from("losses").select("status").eq("id", lossId).single();
  check("sales saved as 'recorded'", rows?.length === 2 && rows.every((r) => r.status === "recorded"));
  check("loss saved as 'recorded'", l?.status === "recorded");
}

console.log("\nInvisible to Jerry until submitted:");
check("owner queue does NOT contain the recorded sales", (await inOwnerQueue([saleA, saleB])) === 0);
{
  const { data: ql } = await owner.from("losses").select("id").eq("id", lossId).in("status", ["pending", "questioned"]);
  check("owner queue does NOT contain the recorded loss", (ql ?? []).length === 0);
}
{
  const { error } = await owner.rpc("fn_approve_sale", { p_sale_id: saleA, p_note: null });
  check("owner cannot approve a not-yet-submitted sale", !!error, "(approve succeeded on recorded sale!)");
}
{
  // engine dup-guard must treat a RECORDED sale as open
  const { error } = await emp2.rpc("fn_record_sale", {
    p_customer_id: null, p_customer: { name: "X" },
    p_part_lines: [], p_engine_ids: [engine.id],
  });
  check("engine in a recorded sale counts as an open sale", !!error && /open sale/i.test(error.message), error?.message);
}

console.log("\nCancel a mistake before submitting:");
{
  const { data, error } = await emp2.from("sales").delete().eq("id", saleA).select("id");
  check("employee can cancel own recorded sale", !error && data?.length === 1, error?.message);
}

console.log("\nSubmit the batch (employee's chosen moment):");
{
  const { error } = await owner.rpc("fn_submit_shop_batch");
  check("owner cannot submit a shop batch", !!error);
}
let batchId = null;
{
  const { data, error } = await emp2.rpc("fn_submit_shop_batch");
  check("fn_submit_shop_batch succeeded", !error, error?.message);
  check("counts: 1 sale + 1 loss", data?.sales === 1 && data?.losses === 1, `(got ${JSON.stringify(data)})`);
  check("submit created a batch", !!data?.batch_id);
  batchId = data?.batch_id;
}
{
  const { data: rows } = await owner.from("sales").select("batch_id").eq("id", saleB).single();
  check("sale carries the batch id", rows?.batch_id === batchId);
}
{
  const { data: s } = await emp2.from("sales").select("status").eq("id", saleB).single();
  const { data: l } = await emp2.from("losses").select("status").eq("id", lossId).single();
  check("sale now PENDING (with Jerry)", s?.status === "pending");
  check("loss now PENDING (with Jerry)", l?.status === "pending");
}
check("owner queue now shows the sale", (await inOwnerQueue([saleB])) === 1);
{
  const { error } = await emp2.rpc("fn_submit_shop_batch");
  check("empty re-submit rejected ('nothing to submit')", !!error && /nothing to submit/i.test(error.message), error?.message);
}
check("stock still untouched before approval (10)", (await shopQty(part.id)) === 10);

console.log("\nOwner reviews the batch as ONE unit:");
{
  const { error } = await emp2.rpc("fn_approve_batch", { p_batch_id: batchId, p_note: null });
  check("employee cannot batch-approve", !!error && /owner/i.test(error.message));
}
{
  // question the loss — approve-all must skip it
  const { error } = await owner.rpc("fn_review_submission", {
    p_kind: "loss", p_id: lossId, p_action: "question", p_note: "BATCH-TEST paano nabasag?",
  });
  check("owner questioned the loss", !error, error?.message);
}
{
  const { data, error } = await owner.rpc("fn_approve_batch", { p_batch_id: batchId, p_note: null });
  check("fn_approve_batch (one click) succeeded", !error, error?.message);
  check("approved 1 sale, skipped the questioned loss", data?.sales === 1 && data?.losses === 0, `(got ${JSON.stringify(data)})`);
}
{
  const { data: s } = await owner.from("sales").select("status").eq("id", saleB).single();
  const { data: e } = await owner.from("engines").select("status").eq("id", engine.id).single();
  const { data: l } = await owner.from("losses").select("status").eq("id", lossId).single();
  check("sale approved + engine sold via batch", s?.status === "approved" && e?.status === "sold");
  check("questioned loss untouched", l?.status === "questioned");
}
{
  const { error } = await owner.rpc("fn_approve_batch", { p_batch_id: batchId, p_note: null });
  check("re-approving a finished batch rejected", !!error && /nothing pending/i.test(error.message), error?.message);
}
{
  const { error } = await owner.rpc("fn_approve_loss", { p_loss_id: lossId, p_note: null });
  check("questioned loss approved individually", !error, error?.message);
}
check("stock 10 → 9 (loss deducted on approval)", (await shopQty(part.id)) === 9, `(got ${await shopQty(part.id)})`);

console.log("\nCleanup:");
{
  const now = new Date().toISOString();
  const { error: retErr } = await owner.rpc("fn_return_stock", {
    p_shop_id: SHOP2, p_reason: `BATCH-TEST cleanup ${RUN}`,
    p_parts: [{ part_id: part.id, qty: 9 }], p_engine_ids: [],
  });
  const r1 = await owner.from("receivings").update({ deleted_at: now }).like("note", "BATCH-TEST%");
  const r2 = await owner.from("deliveries").update({ deleted_at: now }).like("note", "BATCH-TEST%");
  const r3 = await owner.from("returns").update({ deleted_at: now }).like("reason", "BATCH-TEST%");
  const r4 = await owner.from("sales").update({ deleted_at: now }).eq("id", saleB);
  const r5 = await owner.from("losses").update({ deleted_at: now }).eq("id", lossId);
  const r6 = await owner.from("warranties").update({ deleted_at: now }).eq("engine_id", engine.id);
  const r7 = await owner.from("engines").update({ deleted_at: now }).eq("id", engine.id);
  await owner.from("stock_levels").delete().eq("part_id", part.id);
  const r8 = await owner.from("parts").update({ deleted_at: now }).eq("id", part.id);
  const r9 = await owner.from("customers").update({ deleted_at: now }).like("name", "BATCH-TEST%");
  const err = retErr ?? r1.error ?? r2.error ?? r3.error ?? r4.error ?? r5.error ?? r6.error ?? r7.error ?? r8.error ?? r9.error;
  check("fixtures cleaned", !err, err?.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
