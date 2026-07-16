/**
 * Batch submission — the shop chooses the moment its work reaches the owner.
 *
 * Verifies:
 *   • sales/losses save as `recorded` and are INVISIBLE to the owner's queue —
 *     the owner cannot even approve one before it is submitted
 *   • a recorded engine sale still counts as an open sale (dup-guard)
 *   • the shop can cancel a mistake before submitting
 *   • fn_submit_shop_batch flips everything recorded → pending under ONE batch;
 *     only an employee may submit, and an empty submit is refused
 *   • submitting moves no stock
 *   • the owner reviews the batch as one unit: fn_approve_batch approves every
 *     pending item and deliberately SKIPS questioned ones, which resolve alone
 *
 * Provisions its own shop — it must never write into a real branch.
 *
 * Run: node scripts/test-batch-submission.mjs
 */
import {
  owner, RUN, check, section, summary,
  provisionShop, seedPart, seedEngineModel, receive, deliverAndConfirm,
  trackCustomer, cleanup,
} from "./_harness.mjs";

const A = await provisionShop("Batch");
const emp = A.client;

const COST = 6_000;             // ₱60 per filter
const PRICE = 12_000;           // ₱120 per filter
const ENGINE_PRICE = 3_800_000; // ₱38,000
const SERIAL = `ZZ-BATCH-${RUN}`;

const shopQty = async (partId) =>
  (await owner.from("stock_levels").select("qty")
    .eq("part_id", partId).eq("shop_id", A.id).maybeSingle()).data?.qty ?? 0;

// Which of OUR fixture ids sit in the owner's queue (pending/questioned)?
const inOwnerQueue = async (ids) =>
  (await owner.from("sales").select("id").in("id", ids)
    .in("status", ["pending", "questioned"]).is("deleted_at", null)).data?.length ?? 0;

section("Setup (as owner):");
const part = await seedPart({ label: "Fuel Filter", cost: COST, price: PRICE });
const model = await seedEngineModel({ brand: "ZZ-TEST", model: "15MH", hp: 15 });

await receive({
  parts: [{ part_id: part.id, qty: 10, unit_cost_centavos: COST }],
  engines: [{
    serial_number: SERIAL, engine_model_id: model.id, condition: "brand_new",
    cost_centavos: 3_000_000, price_centavos: ENGINE_PRICE, warranty_months: null,
  }],
});
const { data: engine } = await owner
  .from("engines").select("id").eq("serial_number", SERIAL).single();

await deliverAndConfirm(A, { parts: [{ part_id: part.id, qty: 10 }], engine_ids: [engine.id] });
check("fixtures at the shop (10 pcs + engine)", (await shopQty(part.id)) === 10, `got ${await shopQty(part.id)}`);

section("Record 2 sales + 1 loss — all must save as RECORDED:");
const { data: saleA, error: eA } = await emp.rpc("fn_record_sale", {
  p_customer_id: null, p_customer: null,
  p_part_lines: [{ part_id: part.id, qty: 2 }], p_engine_lines: [],
});
const { data: saleB, error: eB } = await emp.rpc("fn_record_sale", {
  p_customer_id: null, p_customer: { name: `ZZ-TEST Ka Pedro ${RUN}` },
  p_part_lines: [], p_engine_lines: [{ engine_id: engine.id, agreed_price_centavos: ENGINE_PRICE }],
});
const { data: lossId, error: eL } = await emp.rpc("fn_record_loss", {
  p_part_id: part.id, p_engine_id: null, p_qty: 1,
  p_reason: "nasira", p_note: `ZZ-TEST basag ${RUN}`,
});
check("all three recorded without error", !eA && !eB && !eL, eA?.message ?? eB?.message ?? eL?.message);
{
  const { data: s } = await owner.from("sales").select("customer_id").eq("id", saleB).single();
  trackCustomer(s?.customer_id);
}
{
  const { data: rows } = await emp.from("sales").select("id, status").in("id", [saleA, saleB]);
  const { data: l } = await emp.from("losses").select("status").eq("id", lossId).single();
  check("sales saved as 'recorded'", rows?.length === 2 && rows.every((r) => r.status === "recorded"));
  check("loss saved as 'recorded'", l?.status === "recorded", l?.status);
}

section("Invisible to the owner until submitted:");
check("owner queue does NOT contain the recorded sales", (await inOwnerQueue([saleA, saleB])) === 0);
{
  const { data: ql } = await owner.from("losses").select("id")
    .eq("id", lossId).in("status", ["pending", "questioned"]);
  check("owner queue does NOT contain the recorded loss", (ql ?? []).length === 0);
}
{
  const { error } = await owner.rpc("fn_approve_sale", { p_sale_id: saleA, p_note: null });
  check("owner cannot approve a not-yet-submitted sale", !!error, "approve succeeded on a recorded sale!");
}
{
  // The engine dup-guard must treat a RECORDED sale as open, not just a pending one.
  const { error } = await emp.rpc("fn_record_sale", {
    p_customer_id: null, p_customer: { name: `ZZ-TEST Dup ${RUN}` },
    p_part_lines: [], p_engine_lines: [{ engine_id: engine.id }],
  });
  check("engine in a recorded sale counts as an open sale", !!error && /open sale/i.test(error.message), error?.message);
}

section("Cancel a mistake before submitting:");
{
  const { data, error } = await emp.from("sales").delete().eq("id", saleA).select("id");
  check("employee can cancel own recorded sale", !error && data?.length === 1, error?.message);
}

section("Submit the batch (the employee's chosen moment):");
{
  const { error } = await owner.rpc("fn_submit_shop_batch");
  check("owner cannot submit a shop batch", !!error, "owner submitted a batch!");
}
let batchId = null;
{
  const { data, error } = await emp.rpc("fn_submit_shop_batch");
  check("fn_submit_shop_batch succeeded", !error, error?.message);
  check("counts: 1 sale + 1 loss", data?.sales === 1 && data?.losses === 1, JSON.stringify(data));
  check("submit created a batch", !!data?.batch_id);
  batchId = data?.batch_id;
}
{
  const { data: s } = await owner.from("sales").select("batch_id").eq("id", saleB).single();
  const { data: l } = await owner.from("losses").select("batch_id").eq("id", lossId).single();
  check("sale + loss carry the same batch id", s?.batch_id === batchId && l?.batch_id === batchId);
}
{
  const { data: s } = await emp.from("sales").select("status").eq("id", saleB).single();
  const { data: l } = await emp.from("losses").select("status").eq("id", lossId).single();
  check("sale now PENDING (with the owner)", s?.status === "pending", s?.status);
  check("loss now PENDING (with the owner)", l?.status === "pending", l?.status);
}
check("owner queue now shows the sale", (await inOwnerQueue([saleB])) === 1);
{
  const { error } = await emp.rpc("fn_submit_shop_batch");
  check("empty re-submit rejected ('nothing to submit')", !!error && /nothing to submit/i.test(error.message), error?.message);
}
check("stock still untouched before approval (10)", (await shopQty(part.id)) === 10, `got ${await shopQty(part.id)}`);

section("Owner reviews the batch as ONE unit:");
{
  const { error } = await emp.rpc("fn_approve_batch", { p_batch_id: batchId, p_note: null });
  check("employee cannot batch-approve", !!error && /owner/i.test(error.message), error?.message);
}
{
  // Question the loss — approve-all must skip it and leave it for individual review.
  const { error } = await owner.rpc("fn_review_submission", {
    p_kind: "loss", p_id: lossId, p_action: "question", p_note: `ZZ-TEST paano nabasag? ${RUN}`,
  });
  check("owner questioned the loss", !error, error?.message);
}
{
  const { data, error } = await owner.rpc("fn_approve_batch", { p_batch_id: batchId, p_note: null });
  check("fn_approve_batch (one click) succeeded", !error, error?.message);
  check("approved 1 sale, skipped the questioned loss", data?.sales === 1 && data?.losses === 0, JSON.stringify(data));
}
{
  const { data: s } = await owner.from("sales").select("status").eq("id", saleB).single();
  const { data: e } = await owner.from("engines").select("status").eq("id", engine.id).single();
  const { data: l } = await owner.from("losses").select("status").eq("id", lossId).single();
  check("sale approved + engine sold via batch", s?.status === "approved" && e?.status === "sold");
  check("questioned loss untouched", l?.status === "questioned", l?.status);
}
{
  const { error } = await owner.rpc("fn_approve_batch", { p_batch_id: batchId, p_note: null });
  check("re-approving a finished batch rejected", !!error && /nothing pending/i.test(error.message), error?.message);
}
{
  const { error } = await owner.rpc("fn_approve_loss", { p_loss_id: lossId, p_note: null });
  check("questioned loss approved individually", !error, error?.message);
}
check("stock 10 → 9 (loss deducted on approval)", (await shopQty(part.id)) === 9, `got ${await shopQty(part.id)}`);

section("Cleanup:");
await cleanup();
summary();
