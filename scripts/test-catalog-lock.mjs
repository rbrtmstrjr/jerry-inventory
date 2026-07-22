/**
 * 0049 — Catalog INSERT lockdown.
 *
 * "A removed button is convention; a revoked grant is enforcement."
 * Creation of parts / engines / engine_models is only possible inside
 * fn_receive_stock. This suite proves the enforcement at the database:
 * even the OWNER's PostgREST session cannot insert directly, while the
 * receiving path (definer function) still creates everything, and the
 * catalog stays editable (UPDATE untouched).
 */
import {
  owner, check, section, summary, cleanup,
  provisionShop, seedSupplier, seedPart, seedEngineModel,
  trackPart, trackEngine, trackEngineModel, RUN,
} from "./_harness.mjs";

const shop = await provisionShop("CatLock");
const supplier = await seedSupplier({ label: "CatLock" });

// ── 1. direct INSERT fails — for the OWNER, not just employees ──────────────
section("Direct INSERT is revoked (owner session, PostgREST)");
{
  const { error: pErr } = await owner.from("parts").insert({
    name: `ZZ-TEST Lock Part ${RUN}`,
    cost_centavos: 100,
    price_centavos: 200,
  });
  check("owner cannot INSERT into parts", !!pErr, "insert unexpectedly succeeded");
  check(
    "parts denial is a permission error, not RLS noise",
    /permission denied/i.test(pErr?.message ?? ""),
    pErr?.message
  );

  const model = await seedEngineModel({ brand: "ZZ-TEST", model: `Lock-${RUN}` });
  const { error: eErr } = await owner.from("engines").insert({
    serial_number: `ZZ-LOCK-${RUN}`,
    engine_model_id: model.id,
    cost_centavos: 100,
    price_centavos: 200,
  });
  check("owner cannot INSERT into engines", /permission denied/i.test(eErr?.message ?? ""), eErr?.message);

  const { error: mErr } = await owner.from("engine_models").insert({
    brand: "ZZ-TEST",
    model: `Lock-Direct-${RUN}`,
  });
  check("owner cannot INSERT into engine_models", /permission denied/i.test(mErr?.message ?? ""), mErr?.message);
}

// ── 2. employees are (still) fully locked out ────────────────────────────────
section("Employee session");
{
  const { error } = await shop.client.from("parts").insert({
    name: `ZZ-TEST Emp Part ${RUN}`,
    cost_centavos: 1,
    price_centavos: 2,
  });
  check("employee cannot INSERT into parts", !!error);
}

// ── 3. the ONE door still works: fn_receive_stock creates catalog rows ───────
section("fn_receive_stock still creates (definer bypasses the revoke)");
{
  const { error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST lock-rcv ${RUN}`,
    p_parts: [{
      qty: 3,
      unit_cost_centavos: 1500,
      new_part: { name: `ZZ-TEST Lock Born ${RUN}`, price_centavos: 2500 },
    }],
    p_engines: [{
      serial_number: `ZZ-LOCK-RCV-${RUN}`,
      cost_centavos: 40000,
      price_centavos: 52000,
      new_model: { brand: "ZZ-TEST", model: `Lock-Born-${RUN}` },
    }],
  });
  check("receiving with inline new part + new model succeeds", !error, error?.message);

  const { data: part } = await owner
    .from("parts").select("id").eq("name", `ZZ-TEST Lock Born ${RUN}`).maybeSingle();
  trackPart(part?.id);
  check("part was born through the receiving", !!part);

  const { data: eng } = await owner
    .from("engines").select("id, engine_model_id").eq("serial_number", `ZZ-LOCK-RCV-${RUN}`).maybeSingle();
  trackEngine(eng?.id);
  trackEngineModel(eng?.engine_model_id);
  check("engine + model were born through the receiving", !!eng);

  // reconciliation: what was received is on the master shelf
  const { data: lvl } = await owner
    .from("stock_levels").select("qty").eq("part_id", part.id).is("shop_id", null).maybeSingle();
  check("received qty sits in master stock", lvl?.qty === 3);
}

// ── 4. UPDATE is untouched — the catalog stays editable ─────────────────────
section("UPDATE still works (view + edit page contract)");
{
  const p = await seedPart({ label: "LockEdit", cost: 1000, price: 2000 });
  const { data: upd, error } = await owner
    .from("parts")
    .update({ price_centavos: 2600, reorder_level: 4, notes: `edited ${RUN}` })
    .eq("id", p.id)
    .select()
    .single();
  check("owner can UPDATE a part", !error && upd?.price_centavos === 2600, error?.message);

  const m = await seedEngineModel({ brand: "ZZ-TEST", model: `Lock-Edit-${RUN}` });
  const { data: mUpd, error: mErr } = await owner
    .from("engine_models")
    .update({ horsepower: 25 })
    .eq("id", m.id)
    .select()
    .single();
  check("owner can UPDATE an engine model (fix a typo)", !mErr && Number(mUpd?.horsepower) === 25, mErr?.message);

  const { data: mDel, error: dErr } = await owner
    .from("engine_models")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", m.id)
    .select()
    .single();
  check("owner can deactivate an engine model (soft-delete)", !dErr && !!mDel?.deleted_at, dErr?.message);

  const { error: empUpd } = await shop.client
    .from("parts").update({ price_centavos: 1 }).eq("id", p.id);
  const { data: after } = await owner
    .from("parts").select("price_centavos").eq("id", p.id).single();
  check(
    "employee UPDATE does nothing (RLS)",
    after?.price_centavos === 2600,
    empUpd?.message ?? `price is ${after?.price_centavos}`
  );
}

// ── 5. Supplier-less "Add product" still creates via the RPC only (0059) ─────
section("Supplier-less Add: creation only via the RPC, direct INSERT still fails");
{
  // the door is the same definer function; direct inserts stay revoked (§1)
  const { data: rid, error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: null,
    p_note: `ZZ-TEST custom-add ${RUN}`,
    p_parts: [{
      qty: 5,
      unit_cost_centavos: 1000,
      new_part: { name: `ZZ-TEST Custom Born ${RUN}`, price_centavos: 1500 },
    }],
  });
  check("supplier-less receiving succeeds", !error, error?.message);

  const { data: part } = await owner
    .from("parts").select("id").eq("name", `ZZ-TEST Custom Born ${RUN}`).maybeSingle();
  trackPart(part?.id);
  check("custom part was born through the RPC (no supplier)", !!part);

  const { data: rcv } = await owner
    .from("receivings").select("supplier_id, total_amount, payment_status").eq("id", rid).single();
  check("supplier-less receiving: no supplier, total 0, settled",
    rcv?.supplier_id === null && rcv?.total_amount === 0 && rcv?.payment_status === "paid",
    JSON.stringify(rcv));
}

await cleanup();
summary();
