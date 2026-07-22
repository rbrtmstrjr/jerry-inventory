/**
 * 0054 — Shop-to-shop transfers (reuse the delivery/transit model).
 *
 * A transfer is a delivery whose source is a shop. This proves the full flow —
 * request (no movement) → owner approve (debit source into transit) → dest
 * confirm (land) → owner resolve shortfall (back to source / write-off) — plus
 * authority, the reconciliation invariant, engine serial-integrity, and the
 * RLS on every new shop-facing / slip view.
 */
import {
  owner, admin, check, section, summary, cleanup,
  provisionShop, seedSupplier, seedPart, seedEngineModel, seedCustomer,
  receive, deliverAndConfirm, trackEngine, RUN,
} from "./_harness.mjs";

const A = await provisionShop("XfrSrc");   // source shop
const B = await provisionShop("XfrDst");   // destination shop
const C = await provisionShop("XfrThird"); // uninvolved third shop
const supplier = await seedSupplier({ label: "Xfr" });

// give A stock: a part (10) + an engine, both landed at A
const part = await seedPart({ label: "XfrPart", cost: 5000, price: 12000 });
await receive({ supplier_id: supplier.id, parts: [{ part_id: part.id, qty: 10, unit_cost_centavos: 5000 }], note: `ZZ-TEST rcv ${RUN}` });
await deliverAndConfirm(A, { parts: [{ part_id: part.id, qty: 10 }] });

const model = await seedEngineModel({ brand: "ZZ-TEST", model: "Xfr" });
await receive({ supplier_id: supplier.id, engines: [{ serial_number: `XFR-${RUN}`, engine_model_id: model.id, cost_centavos: 400000, price_centavos: 600000 }], note: `ZZ-TEST eng ${RUN}` });
const { data: eng } = await owner.from("engines").select("id").eq("serial_number", `XFR-${RUN}`).single();
trackEngine(eng.id);
await deliverAndConfirm(A, { engine_ids: [eng.id] });

// total owned of the part = every stock_levels row + every outstanding transit line
const ownedPart = async () => {
  const { data: lv } = await owner.from("stock_levels").select("qty").eq("part_id", part.id);
  const { data: tr } = await owner.from("stock_in_transit").select("qty").eq("part_id", part.id);
  return (lv ?? []).reduce((s, r) => s + r.qty, 0) + (tr ?? []).reduce((s, r) => s + r.qty, 0);
};
const aQty = async () => (await owner.from("stock_levels").select("qty").eq("part_id", part.id).eq("shop_id", A.id).maybeSingle()).data?.qty ?? 0;
const bQty = async () => (await owner.from("stock_levels").select("qty").eq("part_id", part.id).eq("shop_id", B.id).maybeSingle()).data?.qty ?? 0;

const OWNED = await ownedPart(); // 10
check("setup: A holds 10 of the part", (await aQty()) === 10);

// ── 1. request moves NO stock; visible to owner + source, hidden from dest ──
section("Request (no movement)");
let xfrId;
{
  const { data, error } = await A.client.rpc("fn_request_transfer", {
    p_to_shop_id: B.id,
    p_lines: [{ part_id: part.id, qty: 4 }, { engine_id: eng.id }],
    p_note: `ZZ-TEST xfr ${RUN}`,
  });
  xfrId = data;
  check("source shop can request a transfer", !error && !!data, error?.message);
  check("A's stock is untouched by the request", (await aQty()) === 10);
  check("total owned unchanged", (await ownedPart()) === OWNED);

  const { data: del } = await owner.from("deliveries").select("status, from_shop_id, shop_id").eq("id", xfrId).single();
  check("delivery is a transfer in status 'requested'", del?.status === "requested" && del?.from_shop_id === A.id && del?.shop_id === B.id);

  const { data: aOut } = await A.client.from("shop_outgoing_transfers").select("id, to_shop_name").eq("id", xfrId).maybeSingle();
  check("source sees it in its outgoing list", aOut?.id === xfrId);
  const { data: bIn } = await B.client.from("shop_incoming_deliveries").select("id").eq("id", xfrId).maybeSingle();
  check("destination sees NOTHING until approval", !bIn);
}

// ── 2. authority + validation ───────────────────────────────────────────────
section("Authority & validation");
{
  const { error: notOwner } = await A.client.rpc("fn_approve_transfer", { p_delivery_id: xfrId, p_action: "approve" });
  check("a shop cannot approve a transfer (owner-only)", /owner/i.test(notOwner?.message ?? ""));

  const { error: toSelf } = await A.client.rpc("fn_request_transfer", { p_to_shop_id: A.id, p_lines: [{ part_id: part.id, qty: 1 }] });
  check("transfer to self is rejected", /own shop/i.test(toSelf?.message ?? ""));

  const other = await seedPart({ label: "NotHeld" });
  const { error: notHeld } = await A.client.rpc("fn_request_transfer", { p_to_shop_id: B.id, p_lines: [{ part_id: other.id, qty: 1 }] });
  check("requesting a product the source doesn't hold is rejected", /only have/i.test(notHeld?.message ?? ""));
}

// ── 3. approve debits the source into transit; invariant holds ──────────────
section("Approve (debit source)");
{
  const { error } = await owner.rpc("fn_approve_transfer", { p_delivery_id: xfrId, p_action: "approve" });
  check("owner approves", !error, error?.message);

  check("A's part stock dropped by 4 (10 → 6)", (await aQty()) === 6);
  check("destination stock still 0 until it confirms", (await bQty()) === 0);
  check("total owned still reconciles (moved to transit, not lost)", (await ownedPart()) === OWNED);

  const { data: del } = await owner.from("deliveries").select("status, approved_by, approved_at").eq("id", xfrId).single();
  check("status → in_transit, approver stamped", del?.status === "in_transit" && !!del?.approved_by && !!del?.approved_at);

  const { data: e } = await owner.from("engines").select("status, shop_id").eq("id", eng.id).single();
  check("engine → in_transit heading to the destination", e?.status === "in_transit" && e?.shop_id === B.id);

  const { data: bIn } = await B.client.from("shop_incoming_deliveries").select("id, from_shop_name").eq("id", xfrId).maybeSingle();
  check("destination now sees it as incoming, labelled with the source", bIn?.id === xfrId && bIn?.from_shop_name?.includes("XfrSrc"));
}

// ── 4. approval fails (no partial movement) if the source depleted ──────────
section("Approve re-checks source");
{
  const dp = await seedPart({ label: "Deplete", cost: 100, price: 500 });
  await receive({ supplier_id: supplier.id, parts: [{ part_id: dp.id, qty: 5, unit_cost_centavos: 100 }], note: `ZZ-TEST dep ${RUN}` });
  await deliverAndConfirm(A, { parts: [{ part_id: dp.id, qty: 5 }] });
  const { data: req } = await A.client.rpc("fn_request_transfer", { p_to_shop_id: B.id, p_lines: [{ part_id: dp.id, qty: 5 }], p_note: `ZZ-TEST dep ${RUN}` });
  // simulate: A sold 3 between request and approval
  await admin.from("stock_levels").update({ qty: 2 }).eq("part_id", dp.id).eq("shop_id", A.id);
  const { error } = await owner.rpc("fn_approve_transfer", { p_delivery_id: req, p_action: "approve" });
  check("approve raises when the source no longer has the qty", /no longer has enough/i.test(error?.message ?? ""), error?.message);
  const { data: del } = await owner.from("deliveries").select("status").eq("id", req).single();
  check("the request stays 'requested' — no partial movement", del?.status === "requested");
  await A.client.rpc("fn_cancel_transfer", { p_delivery_id: req });
}

// ── 5. reject ────────────────────────────────────────────────────────────────
section("Reject");
{
  const { data: req } = await A.client.rpc("fn_request_transfer", { p_to_shop_id: B.id, p_lines: [{ part_id: part.id, qty: 2 }], p_note: `ZZ-TEST rej ${RUN}` });
  const before = await aQty();
  const { error: noNote } = await owner.rpc("fn_approve_transfer", { p_delivery_id: req, p_action: "reject" });
  check("a rejection requires a note", /note/i.test(noNote?.message ?? ""));
  const { error } = await owner.rpc("fn_approve_transfer", { p_delivery_id: req, p_action: "reject", p_note: "Not now" });
  const { data: del } = await owner.from("deliveries").select("status, review_note").eq("id", req).single();
  check("reject → status rejected + note, no movement", !error && del?.status === "rejected" && del?.review_note === "Not now" && (await aQty()) === before);
}

// ── 6. destination confirms; shortfall stays in transit; authority ──────────
section("Confirm (destination lands stock)");
{
  const { data: lines } = await owner.from("delivery_lines").select("id, part_id, qty").eq("delivery_id", xfrId);
  const partLine = lines.find((l) => l.part_id === part.id);
  const engLine = lines.find((l) => !l.part_id);

  // a third shop cannot confirm someone else's transfer
  const { error: notMine } = await C.client.rpc("fn_confirm_delivery", {
    p_delivery_id: xfrId,
    p_lines: [{ line_id: partLine.id, qty_received: 4 }, { line_id: engLine.id, qty_received: 1 }],
  });
  check("a third shop cannot confirm the transfer", /not addressed to your shop/i.test(notMine?.message ?? ""));

  // destination confirms: 3 of 4 parts arrive (1 short), engine arrives
  const { data: res, error } = await B.client.rpc("fn_confirm_delivery", {
    p_delivery_id: xfrId,
    p_lines: [{ line_id: partLine.id, qty_received: 3 }, { line_id: engLine.id, qty_received: 1 }],
  });
  check("destination confirms (3 landed, 1 short)", !error && res?.landed === 4 && res?.short === 1, error?.message);
  check("destination now holds 3 of the part", (await bQty()) === 3);

  const { data: e } = await owner.from("engines").select("status, shop_id, serial_number").eq("id", eng.id).single();
  check("engine landed at destination, serial intact", e?.status === "delivered" && e?.shop_id === B.id && e?.serial_number === `XFR-${RUN}`);

  const { data: del } = await owner.from("deliveries").select("status").eq("id", xfrId).single();
  check("shortfall flags the transfer 'discrepancy'", del?.status === "discrepancy");
  check("the missing unit is still in transit (owned unchanged)", (await ownedPart()) === OWNED);
}

// ── 7. resolve — return to source / write-off ───────────────────────────────
section("Resolve shortfall");
{
  const { data: openLine } = await owner
    .from("delivery_lines").select("id, qty_outstanding").eq("delivery_id", xfrId).gt("qty_outstanding", 0).single();

  // a transfer cannot resolve returned_to_master (must be to source)
  const { error: wrongType } = await owner.rpc("fn_resolve_delivery_discrepancy", {
    p_delivery_line_id: openLine.id, p_qty: 1, p_resolution: "returned_to_master", p_reason: "x",
  });
  check("a transfer rejects returned_to_master", /source shop/i.test(wrongType?.message ?? ""));

  const aBefore = await aQty();
  const { error } = await owner.rpc("fn_resolve_delivery_discrepancy", {
    p_delivery_line_id: openLine.id, p_qty: 1, p_resolution: "returned_to_source", p_reason: "found it",
  });
  check("returned_to_source restores the source shelf", !error && (await aQty()) === aBefore + 1, error?.message);
  check("total owned unchanged after return-to-source", (await ownedPart()) === OWNED);

  const { data: del } = await owner.from("deliveries").select("status").eq("id", xfrId).single();
  check("transfer settles to 'resolved'", del?.status === "resolved");

  const { data: audit } = await owner
    .from("delivery_discrepancies").select("resolution").eq("delivery_line_id", openLine.id).single();
  check("resolution is audited", audit?.resolution === "returned_to_source");
}

// ── 8. a write-off reduces total owned and stays out of any shelf ───────────
section("Write-off");
{
  // fresh transfer with a shortfall to write off
  const { data: req } = await A.client.rpc("fn_request_transfer", { p_to_shop_id: B.id, p_lines: [{ part_id: part.id, qty: 2 }], p_note: `ZZ-TEST wo ${RUN}` });
  await owner.rpc("fn_approve_transfer", { p_delivery_id: req, p_action: "approve" });
  const { data: line } = await owner.from("delivery_lines").select("id").eq("delivery_id", req).single();
  await B.client.rpc("fn_confirm_delivery", { p_delivery_id: req, p_lines: [{ line_id: line.id, qty_received: 0 }] });

  const ownedBefore = await ownedPart();
  const { error } = await owner.rpc("fn_resolve_delivery_discrepancy", {
    p_delivery_line_id: line.id, p_qty: 2, p_resolution: "written_off", p_reason: "lost between branches",
  });
  check("write-off succeeds", !error, error?.message);
  check("total owned drops by the written-off qty (real money gone)", (await ownedPart()) === ownedBefore - 2);

  // the write-off is booked at the SOURCE shop but the journal relocates it to
  // transit → the source's ledger still reconciles to its shelf
  const { data: mv } = await owner
    .from("movement_journal").select("location_kind, qty_change, shop_id")
    .eq("part_id", part.id).eq("movement_type", "transit_writeoff");
  const wo = (mv ?? []).find((m) => m.shop_id === A.id);
  check("write-off booked at the source shop", !!wo);
  check("…but the journal shows it at 'transit', not the shop's shelf", wo?.location_kind === "transit");
}

// ── 9. cancel (source only, while requested) ────────────────────────────────
section("Cancel");
{
  const { data: req } = await A.client.rpc("fn_request_transfer", { p_to_shop_id: B.id, p_lines: [{ part_id: part.id, qty: 1 }], p_note: `ZZ-TEST can ${RUN}` });
  const { error: notYours } = await C.client.rpc("fn_cancel_transfer", { p_delivery_id: req });
  check("another shop cannot cancel it", /not from your shop/i.test(notYours?.message ?? ""));
  const { error } = await A.client.rpc("fn_cancel_transfer", { p_delivery_id: req });
  const { data: del } = await owner.from("deliveries").select("status").eq("id", req).single();
  check("source cancels its own pending transfer", !error && del?.status === "cancelled");
  const { error: tooLate } = await A.client.rpc("fn_cancel_transfer", { p_delivery_id: xfrId });
  check("cannot cancel an already-approved transfer", /pending/i.test(tooLate?.message ?? ""));
}

// ── 10. RLS on the new views + the slip's party-scoping + no cost ───────────
section("View RLS & slip scoping");
{
  // outgoing: A sees its own, C sees none
  const { data: aOut } = await A.client.from("shop_outgoing_transfers").select("id").eq("id", xfrId);
  const { data: cOut } = await C.client.from("shop_outgoing_transfers").select("id").eq("id", xfrId);
  check("source sees its outgoing transfer; a third shop does not", (aOut ?? []).length === 1 && (cOut ?? []).length === 0);

  // destination picker (0067): a shop CAN see sibling branches — shops_select
  // alone scopes it to its own shop, so the picker needs the safe view
  const { data: dests } = await A.client.from("shop_transfer_destinations").select("*");
  check("a shop sees sibling shops as transfer destinations", (dests ?? []).some((d) => d.id === B.id));
  check("the destinations view is identity-only (no location/coords/cost)",
    (dests ?? [])[0] && !("location" in dests[0]) && !("latitude" in dests[0]) && !("cost_centavos" in dests[0]));

  // slip readable by owner, source, destination — NOT a third shop or anon
  const slipFor = async (c) => (await c.from("transfer_slip").select("id, from_shop_name, to_shop_name").eq("id", xfrId)).data ?? [];
  check("owner can read the slip", (await slipFor(owner)).length === 1);
  check("source can read the slip", (await slipFor(A.client)).length === 1);
  check("destination can read the slip", (await slipFor(B.client)).length === 1);
  check("a third shop gets NO slip row", (await slipFor(C.client)).length === 0);

  // no cost columns anywhere on the shop-facing/slip views
  const { data: slip } = await owner.from("transfer_slip").select("*").eq("id", xfrId).single();
  check("slip carries no cost", !("cost_centavos" in slip) && !("cost" in slip));
  const { data: outRow } = await A.client.from("shop_outgoing_transfers").select("*").eq("id", xfrId).single();
  check("outgoing view carries no cost", !("cost_centavos" in outRow));
  const { data: slipLine } = await owner.from("transfer_slip_lines").select("*").eq("delivery_id", xfrId).limit(1).single();
  check("slip lines carry no cost", !("cost_centavos" in slipLine) && ("serial_number" in slipLine));
  check("slip shows From → To", !!slip?.from_shop_name && !!slip?.to_shop_name);
}

await cleanup();
summary();
