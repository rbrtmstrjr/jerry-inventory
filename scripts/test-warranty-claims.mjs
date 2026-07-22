/**
 * 0069/0070 — shop-initiated warranty-claim resolution with admin approval.
 *
 * The shop that sold an engine files a claim (repair / replace / refund); the
 * owner approves or rejects. On approval the stock + accounting effects run:
 *   replace — the shop's on-hand replacement engine is booked out as an approved
 *             loss @cost, marked sold to the customer, and the warranty repoints
 *             to it; the defective unit → 'defective' at master.
 *   refund  — refund booked as an approved company expense; defective → master.
 *   repair  — logged only. reject/cancel — nothing moves.
 * Plus authority + RLS (shop can't approve, owner can't request, a third shop
 * can't see or touch the claim).
 */
import {
  owner, admin, RUN, check, section, summary,
  provisionShop, seedEngineModel, seedCustomer,
  receive, deliverAndConfirm, trackEngine, cleanup,
} from "./_harness.mjs";

const A = await provisionShop("WClaim");    // the selling shop
const B = await provisionShop("WClaimOth"); // uninvolved third shop
const model = await seedEngineModel({ brand: "ZZ-TEST", model: "WClaim", hp: 40 });
const customer = await seedCustomer({ label: "Ka Warranty" });

const COST = 400000;
const AGREED = 600000;

// four engines: three to sell (→ warranties), one spare as a replacement
const serials = ["W1", "REPL", "W2", "W3"].map((s) => `WC-${RUN}-${s}`);
await receive({
  engines: serials.map((sn) => ({
    serial_number: sn, engine_model_id: model.id, condition: "brand_new",
    cost_centavos: COST, price_centavos: 0, warranty_months: 12,
    margin_floor_pct: 50, margin_mid_pct: 75, margin_asking_pct: 100,
  })),
});
const { data: engRows } = await owner
  .from("engines").select("id, serial_number").in("serial_number", serials);
const eng = Object.fromEntries(
  serials.map((sn) => [sn.split("-").pop(), engRows.find((e) => e.serial_number === sn)?.id])
);
Object.values(eng).forEach(trackEngine);
await deliverAndConfirm(A, { engine_ids: Object.values(eng) });

// sell one engine end-to-end → returns its warranty id
async function sellAndApprove(engineId) {
  const { data: saleId } = await A.client.rpc("fn_record_sale", {
    p_customer_id: customer.id, p_customer: null, p_part_lines: [],
    p_engine_lines: [{ engine_id: engineId, agreed_price_centavos: AGREED }],
  });
  await A.client.rpc("fn_submit_shop_batch");
  await owner.rpc("fn_approve_sale", { p_sale_id: saleId, p_note: null });
  const { data: w } = await owner.from("warranties").select("id").eq("engine_id", engineId).single();
  return w.id;
}

const W1 = await sellAndApprove(eng.W1);  // for replace
const W2 = await sellAndApprove(eng.W2);  // for refund
const W3 = await sellAndApprove(eng.W3);  // for reject + cancel
check("setup: three warranties minted, one spare engine on hand", !!W1 && !!W2 && !!W3);

// ── 1. authority & scoping (before any claim moves) ─────────────────────────
section("Authority & scoping");
{
  const { error: ownerReq } = await owner.rpc("fn_request_warranty_claim", {
    p_warranty_id: W1, p_issue: "x", p_resolution: "repair",
  });
  check("the owner cannot file a claim (shop-only)", /only shop employees/i.test(ownerReq?.message ?? ""));

  const { error: otherShop } = await B.client.rpc("fn_request_warranty_claim", {
    p_warranty_id: W1, p_issue: "x", p_resolution: "repair",
  });
  check("another shop cannot file on this shop's warranty", /not from your shop/i.test(otherShop?.message ?? ""));

  const { error: badRepl } = await A.client.rpc("fn_request_warranty_claim", {
    p_warranty_id: W1, p_issue: "x", p_resolution: "replace", p_replacement_engine_id: eng.W2,
  });
  check("replace needs an ON-HAND engine (a sold one is rejected)", /on hand/i.test(badRepl?.message ?? ""), badRepl?.message);
}

// ── 2. replace — good unit out (loss @cost), warranty repoints, defective back
section("Replace");
let replaceClaim;
{
  const { data, error } = await A.client.rpc("fn_request_warranty_claim", {
    p_warranty_id: W1, p_issue: `ZZ-TEST gearbox ${RUN}`, p_resolution: "replace",
    p_replacement_engine_id: eng.REPL,
  });
  replaceClaim = data;
  check("shop files a replace claim", !error && !!data, error?.message);
  check("nothing moved yet — replacement still delivered at the shop",
    (await owner.from("engines").select("status").eq("id", eng.REPL).single()).data?.status === "delivered");

  const { data: aSees } = await A.client.from("shop_warranty_claims").select("id, status").eq("id", replaceClaim).maybeSingle();
  check("shop sees its own claim (status requested)", aSees?.status === "requested");
  const { data: bSees } = await B.client.from("shop_warranty_claims").select("id").eq("id", replaceClaim).maybeSingle();
  check("a third shop sees nothing of it", !bSees);

  const { error: notOwner } = await A.client.rpc("fn_approve_warranty_claim", { p_claim_id: replaceClaim });
  check("a shop cannot approve its own claim", /owner/i.test(notOwner?.message ?? ""));

  const { error: apErr } = await owner.rpc("fn_approve_warranty_claim", { p_claim_id: replaceClaim });
  check("owner approves the replace", !apErr, apErr?.message);

  const { data: repl } = await owner.from("engines").select("status, customer_id, shop_id").eq("id", eng.REPL).single();
  check("replacement engine → sold to the customer", repl?.status === "sold" && repl?.customer_id === customer.id);
  const { data: w } = await owner.from("warranties").select("engine_id").eq("id", W1).single();
  check("warranty repoints to the replacement serial", w?.engine_id === eng.REPL);
  const { data: def } = await owner.from("engines").select("status, shop_id").eq("id", eng.W1).single();
  check("defective unit → 'defective' at master (not sellable)", def?.status === "defective" && def?.shop_id === null);
  const { data: loss } = await owner.from("losses")
    .select("value_centavos, reason, status").eq("engine_id", eng.REPL).maybeSingle();
  check("replacement booked as an approved loss @cost, reason 'warranty'",
    loss?.value_centavos === COST && loss?.reason === "warranty" && loss?.status === "approved");
}

// ── 3. refund — company expense + defective back ────────────────────────────
section("Refund");
{
  const REFUND = 500000;
  const { data: claim, error } = await A.client.rpc("fn_request_warranty_claim", {
    p_warranty_id: W2, p_issue: `ZZ-TEST refund ${RUN}`, p_resolution: "refund", p_refund_centavos: REFUND,
  });
  check("shop files a refund claim", !error && !!claim, error?.message);
  const { error: apErr } = await owner.rpc("fn_approve_warranty_claim", { p_claim_id: claim });
  check("owner approves the refund", !apErr, apErr?.message);

  const { data: def } = await owner.from("engines").select("status, shop_id").eq("id", eng.W2).single();
  check("refunded unit → 'defective' at master", def?.status === "defective" && def?.shop_id === null);
  const { data: exp } = await owner.from("expenses")
    .select("amount, scope, status, description, expense_categories(name)")
    .ilike("description", `%${RUN}%`).maybeSingle();
  // description contains the customer name (seeded with RUN)
  check("refund booked as an approved COMPANY expense in Warranty Refunds",
    exp?.amount === REFUND && exp?.scope === "company" && exp?.status === "approved" &&
      exp?.expense_categories?.name === "Warranty Refunds", JSON.stringify(exp));
}

// ── 4. reject — note required, nothing moves ────────────────────────────────
section("Reject");
{
  const { data: claim } = await A.client.rpc("fn_request_warranty_claim", {
    p_warranty_id: W3, p_issue: `ZZ-TEST reject ${RUN}`, p_resolution: "repair",
  });
  const { error: noNote } = await owner.rpc("fn_reject_warranty_claim", { p_claim_id: claim, p_note: "" });
  check("a rejection requires a reason", /reason is required/i.test(noNote?.message ?? ""));
  const { error } = await owner.rpc("fn_reject_warranty_claim", { p_claim_id: claim, p_note: "Out of warranty" });
  const { data: c } = await owner.from("warranty_claims").select("status, review_note").eq("id", claim).single();
  check("reject → status rejected + note", !error && c?.status === "rejected" && c?.review_note === "Out of warranty");
}

// ── 5. cancel — shop, only while requested ──────────────────────────────────
section("Cancel");
{
  const { data: claim } = await A.client.rpc("fn_request_warranty_claim", {
    p_warranty_id: W3, p_issue: `ZZ-TEST cancel ${RUN}`, p_resolution: "repair",
  });
  const { error: notYours } = await B.client.rpc("fn_cancel_warranty_claim", { p_claim_id: claim });
  check("another shop cannot cancel it", /your own/i.test(notYours?.message ?? ""));
  const { error } = await A.client.rpc("fn_cancel_warranty_claim", { p_claim_id: claim });
  const { data: c } = await owner.from("warranty_claims").select("status").eq("id", claim).single();
  check("shop cancels its own pending claim", !error && c?.status === "cancelled");
}

// ── cleanup ─────────────────────────────────────────────────────────────────
section("Cleanup");
// the refund company expense is not shop-scoped, so sweep it by the run tag
await admin.from("expenses").delete().ilike("description", `%${RUN}%`);
await cleanup();
summary();
