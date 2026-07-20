/**
 * Deliveries & Returns verification — the SEND and RETURN sides of the stock
 * math: master → shop, shop → master, the owner-only guards, and the ledger
 * rows each leg writes.
 *
 * Scope note: the in-transit lifecycle (confirm, shortfall, discrepancy
 * resolution, the reconciliation invariant) belongs to test-delivery-confirm.mjs
 * and is deliberately NOT re-tested here. This script uses the harness's
 * send+confirm-in-full helper and asserts the LANDED end state.
 *
 * Provisions its own two shops — it must never write into a real branch.
 *
 * Run: node scripts/test-deliveries.mjs
 */
import {
  owner, RUN, check, section, summary,
  provisionShop, seedPart, seedEngineModel, receive, deliverAndConfirm, cleanup,
} from "./_harness.mjs";

const A = await provisionShop("Deliveries A");
const B = await provisionShop("Deliveries B");
const emp1 = A.client;
const SERIAL = `ZZ-TEST-DLV-${RUN}`;

const masterQty = async (partId) =>
  (await owner.from("stock_levels").select("qty").eq("part_id", partId)
    .is("shop_id", null).maybeSingle()).data?.qty ?? 0;
const shopQty = async (partId, shopId) =>
  (await owner.from("stock_levels").select("qty").eq("part_id", partId)
    .eq("shop_id", shopId).maybeSingle()).data?.qty ?? 0;
const transitQty = async (partId) =>
  ((await owner.from("stock_in_transit").select("qty").eq("part_id", partId)).data ?? [])
    .reduce((s, r) => s + r.qty, 0);
/** Everything we still own of this part, wherever it sits. */
const totalOwned = async (partId) => {
  const { data } = await owner.from("stock_levels").select("qty").eq("part_id", partId);
  return (data ?? []).reduce((s, r) => s + r.qty, 0) + (await transitQty(partId));
};

section("Setup: part with 20 in master + engine in master");
const part = await seedPart({ label: "Propeller", cost: 80000, price: 120000 });
const model = await seedEngineModel({ brand: "DLV", model: "M18E2", hp: 18 });
await receive({
  parts: [{ part_id: part.id, qty: 20, unit_cost_centavos: 80000 }],
  engines: [{
    serial_number: SERIAL, engine_model_id: model.id, condition: "brand_new",
    cost_centavos: 3_000_000, price_centavos: 3_800_000, warranty_months: null,
  }],
});
const { data: engine } = await owner
  .from("engines").select("id").eq("serial_number", SERIAL).single();
check("fixtures ready (master=20, engine in_master)",
  (await masterQty(part.id)) === 20 && !!engine);

// STALE-ASSERTION FIX: this section used to be "Delivery (auto-land)" and
// asserted the shop's stock the instant fn_deliver_stock returned. Since 0029 a
// send only moves master → in-transit; the shop must confirm before anything
// lands. The stock math below is therefore asserted AFTER confirmation, which is
// the point at which the original figures (master 12 / shop 8) are true again.
section("Delivery (send → shop confirms → lands):");
const dlvId = await deliverAndConfirm(A, {
  parts: [{ part_id: part.id, qty: 8 }],
  engine_ids: [engine.id],
});
check("fn_deliver_stock + fn_confirm_delivery succeeded", !!dlvId);
check("master 20 → 12", (await masterQty(part.id)) === 12);
check("shop A stock = 8 (landed on confirmation)", (await shopQty(part.id, A.id)) === 8);
check("nothing left in transit", (await transitQty(part.id)) === 0);
check("a delivery moves stock, never destroys it (still own 20)",
  (await totalOwned(part.id)) === 20);
{
  const { data: d } = await owner.from("deliveries").select("status").eq("id", dlvId).single();
  check("delivery status = confirmed", d?.status === "confirmed", `got ${d?.status}`);
}
{
  const { data: e } = await owner.from("engines").select("status, shop_id").eq("id", engine.id).single();
  check("engine delivered @ shop A", e?.status === "delivered" && e?.shop_id === A.id);
}
{
  // Still 4 rows for the round trip — but they are written in two steps now:
  // the − master pair on send, the + shop pair on confirmation.
  const { data: moves } = await owner.from("stock_movements").select("*").eq("delivery_id", dlvId);
  check("ledger: 4 rows (− master / + shop, part + engine)", moves?.length === 4, `got ${moves?.length}`);
  const partOut = moves?.find((m) => m.part_id === part.id && m.qty_change === -8 && m.shop_id === null);
  const partIn = moves?.find((m) => m.part_id === part.id && m.qty_change === 8 && m.shop_id === A.id);
  check("ledger: part −8 master, +8 shop A", !!partOut && !!partIn);
  const engOut = moves?.find((m) => m.engine_id === engine.id && m.qty_change === -1 && m.shop_id === null);
  const engIn = moves?.find((m) => m.engine_id === engine.id && m.qty_change === 1 && m.shop_id === A.id);
  check("ledger: engine −1 master, +1 shop A", !!engOut && !!engIn);
}

section("Employee visibility after delivery:");
{
  const { data } = await emp1.from("shop_stock").select("*").eq("part_id", part.id);
  // 0053: the shop DOES see its own-shop cost now (read-only tawad floor).
  check("shop A employee sees delivered part (qty 8, with own-shop cost)",
    data?.length === 1 && data[0].qty === 8 && typeof data[0].cost_centavos === "number");
  const { data: se } = await emp1.from("shop_engines").select("*").eq("engine_id", engine.id);
  check("shop A employee sees delivered engine", se?.length === 1);
}

section("Guards:");
{
  const { error } = await owner.rpc("fn_deliver_stock", {
    p_shop_id: A.id, p_note: `ZZ-TEST too much ${RUN}`,
    p_parts: [{ part_id: part.id, qty: 999 }], p_engine_ids: [],
  });
  check("insufficient master stock rejected", !!error && /not enough/i.test(error.message), error?.message);
}
{
  check("rejected delivery moved nothing (master still 12)", (await masterQty(part.id)) === 12);
}
{
  const { error } = await owner.rpc("fn_deliver_stock", {
    p_shop_id: B.id, p_note: `ZZ-TEST already gone ${RUN}`,
    p_parts: [], p_engine_ids: [engine.id],
  });
  check("engine already delivered can't deliver again", !!error, error?.message);
}
{
  const { error } = await emp1.rpc("fn_deliver_stock", {
    p_shop_id: A.id, p_note: "sneaky",
    p_parts: [{ part_id: part.id, qty: 1 }], p_engine_ids: [],
  });
  check("EMPLOYEE cannot deliver", !!error && /owner/i.test(error.message), error?.message);
}
{
  const { error } = await emp1.rpc("fn_return_stock", {
    p_shop_id: A.id, p_reason: "sneaky",
    p_parts: [{ part_id: part.id, qty: 1 }], p_engine_ids: [],
  });
  check("EMPLOYEE cannot return", !!error && /owner/i.test(error.message), error?.message);
}
{
  const { error } = await owner.rpc("fn_return_stock", {
    p_shop_id: B.id, p_reason: `ZZ-TEST wrong shop ${RUN}`,
    p_parts: [{ part_id: part.id, qty: 1 }], p_engine_ids: [],
  });
  check("return from shop without stock rejected", !!error, error?.message);
}
{
  const { error } = await owner.rpc("fn_return_stock", {
    p_shop_id: A.id, p_reason: `ZZ-TEST over-return ${RUN}`,
    p_parts: [{ part_id: part.id, qty: 9 }], p_engine_ids: [],
  });
  check("cannot return more than the shop holds", !!error && /enough/i.test(error.message), error?.message);
}

section("Return (shop → master):");
const { data: retId, error: retErr } = await owner.rpc("fn_return_stock", {
  p_shop_id: A.id,
  p_reason: `ZZ-TEST slow mover ${RUN}`,
  p_parts: [{ part_id: part.id, qty: 3 }],
  p_engine_ids: [engine.id],
});
check("fn_return_stock succeeded", !retErr, retErr?.message);
check("shop A 8 → 5", (await shopQty(part.id, A.id)) === 5);
check("master 12 → 15", (await masterQty(part.id)) === 15);
check("a return is not a loss — still own 20", (await totalOwned(part.id)) === 20);
{
  const { data: e } = await owner.from("engines").select("status, shop_id").eq("id", engine.id).single();
  check("engine back in_master", e?.status === "in_master" && e?.shop_id === null);
}
{
  const { data: moves } = await owner.from("stock_movements").select("*").eq("return_id", retId);
  check("ledger: 4 return rows", moves?.length === 4, `got ${moves?.length}`);
  const types = new Set((moves ?? []).map((m) => m.movement_type));
  // Returns, shop losses and transit write-offs are three different things and
  // reports must be able to tell them apart.
  check("ledger: tagged `return`, never `loss`/`transit_writeoff`",
    types.size === 1 && types.has("return"), [...types].join(","));
  const partOut = moves?.find((m) => m.part_id === part.id && m.qty_change === -3 && m.shop_id === A.id);
  const partIn = moves?.find((m) => m.part_id === part.id && m.qty_change === 3 && m.shop_id === null);
  check("ledger: part −3 shop A, +3 master", !!partOut && !!partIn);
}
{
  const { data } = await owner.from("return_lines").select("part_id, engine_id, qty").eq("return_id", retId);
  check("return has 2 lines (part + engine)", data?.length === 2, `got ${data?.length}`);
}

section("A returned engine is genuinely back in master:");
{
  // The return is only complete if the serial can be sent out again — this time
  // to the OTHER shop, proving shop_id was really cleared.
  const dlv2 = await deliverAndConfirm(B, { engine_ids: [engine.id] });
  check("returned engine can be re-delivered", !!dlv2);
  const { data: e } = await owner.from("engines").select("status, shop_id").eq("id", engine.id).single();
  check("engine now at shop B", e?.status === "delivered" && e?.shop_id === B.id);
}

section("Delivery note data:");
{
  const { data: d } = await owner
    .from("deliveries")
    .select("id, shops(name), delivery_lines(qty, parts(name), engines(serial_number))")
    .eq("id", dlvId)
    .single();
  check("delivery joins for note render",
    d?.shops?.name === A.name && d?.delivery_lines?.length === 2,
    `${d?.shops?.name} / ${d?.delivery_lines?.length} lines`);
}

section("Cleanup:");
await cleanup();
summary();
