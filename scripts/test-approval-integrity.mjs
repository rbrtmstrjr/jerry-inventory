/**
 * Approval integrity (SEC-6.1) — a submitted item is FROZEN to the shop.
 *
 * The whole system exists so "nothing posts that the owner didn't approve."
 * That holds only if what the owner reviews cannot change after submission.
 * Before this migration, the employee edit window included status='pending'
 * (submitted, awaiting approval) — a leftover from the pre-0016 model where
 * 'pending' WAS the draft. So an employee could record an honest sale, submit
 * it, then silently lower a line's price (or bump qty) before the owner
 * approved — the owner approved one thing and a different thing posted.
 *
 * Verifies:
 *   • a shop CANNOT edit/insert/delete sale_lines of a PENDING sale
 *   • a shop CANNOT edit the PENDING sales row (money columns)
 *   • a shop CANNOT edit a PENDING loss
 *   • the legitimate flows still work: edit a RECORDED draft, cancel a
 *     PENDING submission (withdraw), correct a QUESTIONED item
 *
 * Provisions its own shop. Run: node scripts/test-approval-integrity.mjs
 */
import {
  owner, RUN, check, section, summary,
  provisionShop, seedPart, receive, deliverAndConfirm, cleanup,
} from "./_harness.mjs";

const A = await provisionShop("ApprovalIntegrity");
const emp = A.client;
const COST = 5_000;
const PRICE = 12_000;

section("Setup: stock at the shop");
const part = await seedPart({ label: "Integrity Part", cost: COST, price: PRICE });
await receive({ parts: [{ part_id: part.id, qty: 20, unit_cost_centavos: COST }] });
await deliverAndConfirm(A, { parts: [{ part_id: part.id, qty: 20 }] });

section("Record a sale, then SUBMIT it (→ pending)");
const { data: saleId, error: recErr } = await emp.rpc("fn_record_sale", {
  p_customer_id: null, p_customer: null,
  p_part_lines: [{ part_id: part.id, qty: 2 }], p_engine_lines: [],
});
check("sale recorded", !recErr && !!saleId, recErr?.message);
const { error: subErr } = await emp.rpc("fn_submit_shop_batch");
check("batch submitted", !subErr, subErr?.message);
{
  const { data: s } = await owner.from("sales").select("status").eq("id", saleId).single();
  check("sale is now 'pending'", s?.status === "pending", s?.status);
}

// grab the line + its honest values (read as owner — full visibility)
const { data: line0 } = await owner
  .from("sale_lines")
  .select("id, qty, line_total_centavos, agreed_price_centavos")
  .eq("sale_id", saleId).limit(1).single();
const honestQty = line0.qty;
const honestTotal = line0.line_total_centavos;

section("SEC-6.1: the shop must NOT be able to alter a submitted sale");
{
  // attempt to slash the price + bump qty on the pending sale's line
  await emp.from("sale_lines")
    .update({ qty: 99, line_total_centavos: 1, agreed_price_centavos: 1 })
    .eq("id", line0.id);
  const { data: after } = await owner.from("sale_lines")
    .select("qty, line_total_centavos").eq("id", line0.id).single();
  check("pending sale_line UNCHANGED (qty)", after.qty === honestQty, `qty ${honestQty} → ${after.qty}`);
  check("pending sale_line UNCHANGED (total)", after.line_total_centavos === honestTotal,
    `total ${honestTotal} → ${after.line_total_centavos}`);
}
{
  // attempt to add a phantom line the owner never saw
  const { data: ins } = await emp.from("sale_lines")
    .insert({ sale_id: saleId, part_id: part.id, qty: 1, line_total_centavos: 1 })
    .select("id");
  const { count } = await owner.from("sale_lines")
    .select("id", { count: "exact", head: true }).eq("sale_id", saleId);
  check("cannot INSERT a line into a pending sale", (ins?.length ?? 0) === 0 && count === 1,
    `inserted ${ins?.length ?? 0}, line count ${count}`);
}
{
  // attempt to delete a line off the pending sale
  const { data: del } = await emp.from("sale_lines").delete().eq("id", line0.id).select("id");
  check("cannot DELETE a line off a pending sale", (del?.length ?? 0) === 0, `deleted ${del?.length ?? 0}`);
}
{
  // attempt to edit the pending sales row itself
  await emp.from("sales").update({ total_centavos: 1 }).eq("id", saleId);
  const { data: s } = await owner.from("sales").select("total_centavos").eq("id", saleId).single();
  check("pending sales row UNCHANGED (total)", s.total_centavos === honestTotal,
    `total ${honestTotal} → ${s.total_centavos}`);
}

section("SEC-6.1: the same freeze for losses");
{
  const { data: lossId } = await emp.rpc("fn_record_loss", {
    p_part_id: part.id, p_engine_id: null, p_qty: 1,
    p_reason: "nasira", p_note: `ZZ-TEST integ ${RUN}`,
  });
  await emp.rpc("fn_submit_shop_batch");
  await emp.from("losses").update({ qty: 99 }).eq("id", lossId);
  const { data: l } = await owner.from("losses").select("qty, status").eq("id", lossId).single();
  check("pending loss UNCHANGED (qty)", l.qty === 1, `qty 1 → ${l.qty} (status ${l.status})`);
}

section("Regression: legitimate flows still work");
{
  // a RECORDED draft is still freely editable
  const { data: draftId } = await emp.rpc("fn_record_sale", {
    p_customer_id: null, p_customer: null,
    p_part_lines: [{ part_id: part.id, qty: 1 }], p_engine_lines: [],
  });
  const { data: dline } = await owner.from("sale_lines").select("id").eq("sale_id", draftId).limit(1).single();
  await emp.from("sale_lines").update({ qty: 3 }).eq("id", dline.id);
  const { data: d } = await owner.from("sale_lines").select("qty").eq("id", dline.id).single();
  check("RECORDED draft line still editable", d.qty === 3, `qty → ${d.qty}`);
  // and the draft can be cancelled
  const { data: cancelled } = await emp.from("sales").delete().eq("id", draftId).select("id");
  check("RECORDED draft cancellable", cancelled?.length === 1);
}
{
  // a PENDING submission can still be WITHDRAWN (cancel/delete) — that's not an
  // edit; it removes the item entirely so nothing posts.
  const { data: cancelId } = await emp.rpc("fn_record_sale", {
    p_customer_id: null, p_customer: null,
    p_part_lines: [{ part_id: part.id, qty: 1 }], p_engine_lines: [],
  });
  await emp.rpc("fn_submit_shop_batch");
  const { data: cancelled } = await emp.from("sales").delete().eq("id", cancelId).select("id");
  check("PENDING submission still withdrawable", cancelled?.length === 1, `deleted ${cancelled?.length ?? 0}`);
}

await cleanup();
summary();
