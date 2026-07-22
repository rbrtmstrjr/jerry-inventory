/**
 * 0065 — Shop-initiated returns with admin approval.
 *
 * A return becomes a REQUEST → APPROVE flow (mirrors transfers 0054): the SHOP
 * initiates a return of its own stock, the OWNER approves (good → master,
 * damaged → an approved loss at cost) or rejects. This proves the full flow —
 * request (no movement) → validation/authority → approve (good lands in master,
 * damaged becomes shrinkage) → reject → cancel → approve re-checks the shelf —
 * plus the reconciliation invariant and the shop-facing view RLS.
 */
import {
  owner, admin, anonClient, check, section, summary, cleanup,
  provisionShop, seedSupplier, seedPart, seedEngineModel,
  receive, deliverAndConfirm, trackEngine, RUN,
} from "./_harness.mjs";

const A = await provisionShop("RetShop");   // the returning shop
const C = await provisionShop("RetOther");  // an uninvolved third shop
const supplier = await seedSupplier({ label: "Ret" });

// A holds 10 of a part (master keeps 10) + one delivered engine
const part = await seedPart({ label: "RetPart", cost: 5000, price: 12000 });
await receive({ supplier_id: supplier.id, parts: [{ part_id: part.id, qty: 20, unit_cost_centavos: 5000 }], note: `ZZ-TEST rcv ${RUN}` });
await deliverAndConfirm(A, { parts: [{ part_id: part.id, qty: 10 }] });

const model = await seedEngineModel({ brand: "ZZ-TEST", model: "Ret" });
await receive({ supplier_id: supplier.id, engines: [{ serial_number: `RET-${RUN}`, engine_model_id: model.id, cost_centavos: 400000, price_centavos: 600000 }], note: `ZZ-TEST eng ${RUN}` });
const { data: eng } = await owner.from("engines").select("id").eq("serial_number", `RET-${RUN}`).single();
trackEngine(eng.id);
await deliverAndConfirm(A, { engine_ids: [eng.id] });

// a 2nd engine for the damaged-return path
await receive({ supplier_id: supplier.id, engines: [{ serial_number: `RETD-${RUN}`, engine_model_id: model.id, cost_centavos: 400000, price_centavos: 600000 }], note: `ZZ-TEST eng2 ${RUN}` });
const { data: eng2 } = await owner.from("engines").select("id").eq("serial_number", `RETD-${RUN}`).single();
trackEngine(eng2.id);
await deliverAndConfirm(A, { engine_ids: [eng2.id] });

// total owned of the part = every stock_levels row (returns have no transit)
const ownedPart = async () => {
  const { data: lv } = await owner.from("stock_levels").select("qty").eq("part_id", part.id);
  return (lv ?? []).reduce((s, r) => s + r.qty, 0);
};
const shopQty = async (shop) => (await owner.from("stock_levels").select("qty").eq("part_id", part.id).eq("shop_id", shop).maybeSingle()).data?.qty ?? 0;
const masterQty = async () => (await owner.from("stock_levels").select("qty").eq("part_id", part.id).is("shop_id", null).maybeSingle()).data?.qty ?? 0;

const OWNED = await ownedPart(); // 20 (master 10 + A 10)
check("setup: A holds 10, master holds 10", (await shopQty(A.id)) === 10 && (await masterQty()) === 10);

// ── 1. request moves NO stock; visible to the shop, scoped by the safe view ──
section("Request (no movement)");
let retId;
{
  const { data, error } = await A.client.rpc("fn_request_return", {
    p_reason: `ZZ-TEST wrong-order ${RUN}`,
    p_parts: [{ part_id: part.id, qty_good: 3, qty_damaged: 1 }],
    p_engine_ids: [{ engine_id: eng.id, condition: "good" }],
  });
  retId = data;
  check("shop can request a return", !error && !!data, error?.message);
  check("A's stock is untouched by the request (still 10)", (await shopQty(A.id)) === 10);
  check("master is untouched (still 10)", (await masterQty()) === 10);
  check("total owned unchanged", (await ownedPart()) === OWNED);

  const { data: ret } = await owner.from("returns").select("status, shop_id, requested_by").eq("id", retId).single();
  check("return is 'requested', stamped with the requester", ret?.status === "requested" && ret?.shop_id === A.id && !!ret?.requested_by);

  const { data: aRet } = await A.client.from("shop_returns").select("id, status, qty_total, line_count").eq("id", retId).maybeSingle();
  check("shop sees it in its own returns list", aRet?.id === retId && aRet?.status === "requested" && aRet?.qty_total === 5 && aRet?.line_count === 2);
  const { data: cRet } = await C.client.from("shop_returns").select("id").eq("id", retId).maybeSingle();
  check("a third shop sees NOTHING of it (RLS)", !cRet);
}

// ── 2. validation & authority ────────────────────────────────────────────────
section("Validation & authority");
{
  const { error: ownerReq } = await owner.rpc("fn_request_return", { p_reason: "x", p_parts: [{ part_id: part.id, qty_good: 1 }] });
  check("the owner cannot request a return (shop-only)", /only a shop/i.test(ownerReq?.message ?? ""));

  const { error: tooMany } = await A.client.rpc("fn_request_return", { p_reason: "x", p_parts: [{ part_id: part.id, qty_good: 999 }] });
  check("requesting more than the shop holds is rejected", /enough/i.test(tooMany?.message ?? ""));

  const { error: empty } = await A.client.rpc("fn_request_return", { p_reason: "x" });
  check("a return with no items is rejected", /at least one item/i.test(empty?.message ?? ""));

  const { error: notOwner } = await A.client.rpc("fn_approve_return", { p_return_id: retId });
  check("a shop cannot approve its own return (owner-only)", /owner/i.test(notOwner?.message ?? ""));
}

// ── 3. approve — good lands in master, damaged becomes shrinkage ─────────────
section("Approve (good → master, damaged → loss)");
{
  const { error } = await owner.rpc("fn_approve_return", { p_return_id: retId });
  check("owner approves", !error, error?.message);

  check("A's part stock dropped by all 4 returned (10 → 6)", (await shopQty(A.id)) === 6);
  check("master gained only the 3 GOOD units (10 → 13)", (await masterQty()) === 13);
  check("total owned dropped by the 1 damaged unit (real money gone)", (await ownedPart()) === OWNED - 1);

  const { data: loss } = await owner.from("losses")
    .select("qty, status, value_centavos, reason").eq("part_id", part.id).eq("shop_id", A.id).eq("reason", "nasira").maybeSingle();
  check("damaged unit → an approved loss at cost (₱50.00)", loss?.qty === 1 && loss?.status === "approved" && loss?.value_centavos === 5000);

  const { data: e } = await owner.from("engines").select("status, shop_id").eq("id", eng.id).single();
  check("good engine returned to master", e?.status === "in_master" && e?.shop_id === null);

  const { data: mv } = await owner.from("stock_movements").select("qty_change, shop_id").eq("part_id", part.id).eq("movement_type", "return");
  const legs = mv ?? [];
  check("return booked as a two-legged move (shop − / master +) for the good units",
    legs.some((m) => m.shop_id === A.id && m.qty_change === -3) && legs.some((m) => m.shop_id === null && m.qty_change === 3));

  const { data: ret } = await owner.from("returns").select("status, approved_by, approved_at").eq("id", retId).single();
  check("return → approved, approver stamped", ret?.status === "approved" && !!ret?.approved_by && !!ret?.approved_at);

  const { error: again } = await owner.rpc("fn_approve_return", { p_return_id: retId });
  check("an already-approved return cannot be approved again", /not pending/i.test(again?.message ?? ""));
}

// ── 4. a damaged engine is soft-deleted into a loss, never back to master ────
section("Approve — damaged engine → loss");
{
  const { data: req } = await A.client.rpc("fn_request_return", {
    p_reason: `ZZ-TEST eng-damaged ${RUN}`,
    p_engine_ids: [{ engine_id: eng2.id, condition: "damaged" }],
  });
  const { error } = await owner.rpc("fn_approve_return", { p_return_id: req });
  check("owner approves the damaged-engine return", !error, error?.message);
  const { data: e } = await owner.from("engines").select("deleted_at, status").eq("id", eng2.id).single();
  check("damaged engine is soft-deleted (never resold from master)", !!e?.deleted_at);
  const { data: loss } = await owner.from("losses").select("value_centavos, status").eq("engine_id", eng2.id).maybeSingle();
  check("damaged engine → an approved loss at its cost (₱4000.00)", loss?.value_centavos === 400000 && loss?.status === "approved");
}

// ── 5. reject — note required, no stock moved ────────────────────────────────
section("Reject");
{
  const { data: req } = await A.client.rpc("fn_request_return", { p_reason: "x", p_parts: [{ part_id: part.id, qty_good: 2 }] });
  const before = await shopQty(A.id);
  const { error: noNote } = await owner.rpc("fn_reject_return", { p_return_id: req, p_note: "" });
  check("a rejection requires a note", /reason is required/i.test(noNote?.message ?? ""));
  const { error } = await owner.rpc("fn_reject_return", { p_return_id: req, p_note: "Send it next delivery instead" });
  const { data: ret } = await owner.from("returns").select("status, review_note").eq("id", req).single();
  check("reject → status rejected + note, no movement",
    !error && ret?.status === "rejected" && ret?.review_note === "Send it next delivery instead" && (await shopQty(A.id)) === before);
}

// ── 6. cancel — the shop, only while requested ──────────────────────────────
section("Cancel");
{
  const { data: req } = await A.client.rpc("fn_request_return", { p_reason: "x", p_parts: [{ part_id: part.id, qty_good: 1 }] });
  const { error: notYours } = await C.client.rpc("fn_cancel_return", { p_return_id: req });
  check("another shop cannot cancel it", /your own/i.test(notYours?.message ?? ""));
  const { error } = await A.client.rpc("fn_cancel_return", { p_return_id: req });
  const { data: ret } = await owner.from("returns").select("status").eq("id", req).single();
  check("the shop cancels its own pending return", !error && ret?.status === "cancelled");
  const { error: tooLate } = await A.client.rpc("fn_cancel_return", { p_return_id: retId });
  check("an already-approved return cannot be cancelled", /pending/i.test(tooLate?.message ?? ""));
}

// ── 7. approve re-checks the shelf (RAISES if sold since the request) ────────
section("Approve re-checks the shelf");
{
  const { data: req } = await A.client.rpc("fn_request_return", { p_reason: "x", p_parts: [{ part_id: part.id, qty_good: 3 }] });
  // simulate: the shop sold the stock between request and approval
  await admin.from("stock_levels").update({ qty: 1 }).eq("part_id", part.id).eq("shop_id", A.id);
  const { error } = await owner.rpc("fn_approve_return", { p_return_id: req });
  check("approve raises when the shop no longer holds the qty", /no longer has enough/i.test(error?.message ?? ""), error?.message);
  const { data: ret } = await owner.from("returns").select("status").eq("id", req).single();
  check("the request stays 'requested' — no partial movement", ret?.status === "requested");
  await A.client.rpc("fn_cancel_return", { p_return_id: req });
}

// ── 8. Return Slip (0066) — party-scoped, no cost ───────────────────────────
section("Return slip RLS & content");
{
  const slipFor = async (c) => (await c.from("return_slip").select("*").eq("id", retId)).data ?? [];
  check("owner can read the slip", (await slipFor(owner)).length === 1);
  check("the returning shop can read its slip", (await slipFor(A.client)).length === 1);
  check("a third shop gets NO slip row", (await slipFor(C.client)).length === 0);
  check("an anon session gets NO slip row", (await slipFor(anonClient())).length === 0);

  const [slip] = await slipFor(owner);
  check("slip names the returning shop + carries no cost",
    slip?.shop_name?.includes("RetShop") && !("cost_centavos" in (slip ?? {})));

  const { data: slipLines } = await owner.from("return_slip_lines").select("*").eq("return_id", retId);
  const partLine = (slipLines ?? []).find((l) => l.serial_number == null);
  check("slip lines split good vs damaged (3 good, 1 damaged of the part)",
    partLine?.qty_good === 3 && partLine?.qty_damaged === 1 && partLine?.qty === 4);
  check("slip lines carry no cost", !("cost_centavos" in (partLine ?? {})));
}

await cleanup();
summary();
