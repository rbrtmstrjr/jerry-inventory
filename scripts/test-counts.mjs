/**
 * Monthly count verification — the snapshot FREEZES expected stock, counts are
 * owner-entered, and a shortage becomes a reason-coded loss in the NORMAL
 * approval queue (no separate reconciliation subsystem). Approval is what
 * deducts.
 *
 * Provisions its own shop, so the snapshot covers exactly the parts this script
 * put there — nothing from a real branch — and hard-cleans afterwards.
 *
 * Run: node scripts/test-counts.mjs
 */
import {
  owner, RUN, check, section, summary,
  provisionShop, seedPart, receive, deliverAndConfirm, cleanup,
} from "./_harness.mjs";

const SHOP = await provisionShop("Counts");
const emp = SHOP.client;

const shopQty = async (partId) =>
  (await owner.from("stock_levels").select("qty").eq("part_id", partId)
    .eq("shop_id", SHOP.id).maybeSingle()).data?.qty ?? 0;

section("Setup: three parts at the shop (12 hooks, 5 floats, 4 sinkers)");
const hooks = await seedPart({ label: "Hooks", cost: 500, price: 1000 });
const floats = await seedPart({ label: "Floats", cost: 2000, price: 3500 });
const sinkers = await seedPart({ label: "Sinkers", cost: 300, price: 700 });
await receive({
  parts: [
    { part_id: hooks.id, qty: 12, unit_cost_centavos: 500 },
    { part_id: floats.id, qty: 5, unit_cost_centavos: 2000 },
    { part_id: sinkers.id, qty: 4, unit_cost_centavos: 300 },
  ],
});
await deliverAndConfirm(SHOP, {
  parts: [
    { part_id: hooks.id, qty: 12 },
    { part_id: floats.id, qty: 5 },
    { part_id: sinkers.id, qty: 4 },
  ],
});
check("stock at the shop: hooks 12, floats 5, sinkers 4",
  (await shopQty(hooks.id)) === 12 && (await shopQty(floats.id)) === 5 && (await shopQty(sinkers.id)) === 4);

section("Snapshot (freeze):");
const { data: snapId, error: snapErr } = await owner.rpc("fn_create_count_snapshot", {
  p_shop_id: SHOP.id, p_note: `ZZ-TEST month-end ${RUN}`,
});
check("snapshot created", !snapErr, snapErr?.message);
const { data: snapLines } = await owner
  .from("count_snapshot_lines").select("id, part_id, expected_qty, counted_qty, shortage_loss_id")
  .eq("snapshot_id", snapId);
const hookLine = snapLines?.find((l) => l.part_id === hooks.id);
const floatLine = snapLines?.find((l) => l.part_id === floats.id);
const sinkerLine = snapLines?.find((l) => l.part_id === sinkers.id);
check("lines include all parts with expected qty",
  hookLine?.expected_qty === 12 && floatLine?.expected_qty === 5 && sinkerLine?.expected_qty === 4);
// Only possible on a throwaway shop: the sheet is EXACTLY this shop's stock.
check("sheet is scoped to this shop's stock only (3 lines)", snapLines?.length === 3,
  `got ${snapLines?.length}`);
check("counts start blank", (snapLines ?? []).every((l) => l.counted_qty === null));

{
  // STALE-MECHANISM FIX: the original proved the freeze with a shop sale that it
  // then approved directly. Since 0016 a shop sale is inserted as `recorded` and
  // only reaches the approval queue via a batch submit, so that path no longer
  // models anything real — and the freeze has nothing to do with sales. Any
  // later stock movement proves the same property, so a delivery is used here
  // (and reversed) instead of dragging the approval pipeline into this script.
  await receive({ parts: [{ part_id: hooks.id, qty: 2, unit_cost_centavos: 500 }] });
  await deliverAndConfirm(SHOP, { parts: [{ part_id: hooks.id, qty: 2 }] });
  check("stock really moved after the snapshot (14)", (await shopQty(hooks.id)) === 14);
  const { data: after } = await owner
    .from("count_snapshot_lines").select("expected_qty").eq("id", hookLine.id).single();
  check("expected stays frozen after later stock movement (12)", after?.expected_qty === 12,
    `got ${after?.expected_qty}`);
  // put stock back so the count math below is clean
  await owner.rpc("fn_return_stock", {
    p_shop_id: SHOP.id, p_reason: `ZZ-TEST reset ${RUN}`,
    p_parts: [{ part_id: hooks.id, qty: 2 }], p_engine_ids: [],
  });
  check("stock restored to 12 for the count", (await shopQty(hooks.id)) === 12);
}

section("Enter counts (hooks 9 → short 3; floats 5 → match; sinkers 6 → over):");
{
  const { error } = await owner.rpc("fn_save_count", {
    p_snapshot_id: snapId,
    p_lines: [
      { line_id: hookLine.id, counted_qty: 9 },
      { line_id: floatLine.id, counted_qty: 5 },
      { line_id: sinkerLine.id, counted_qty: 6 },
    ],
  });
  check("counts saved", !error, error?.message);
}
{
  const { error } = await owner.rpc("fn_save_count", {
    p_snapshot_id: snapId, p_lines: [{ line_id: hookLine.id, counted_qty: -1 }],
  });
  check("negative count rejected", !!error && /negative/i.test(error.message), error?.message);
}
{
  const { error } = await emp.rpc("fn_create_count_snapshot", {
    p_shop_id: SHOP.id, p_note: "sneaky",
  });
  check("employee cannot create a count sheet", !!error && /owner/i.test(error.message), error?.message);
}
{
  const { error } = await emp.rpc("fn_save_count", {
    p_snapshot_id: snapId, p_lines: [{ line_id: hookLine.id, counted_qty: 12 }],
  });
  check("employee cannot enter counts", !!error && /owner/i.test(error.message), error?.message);
}
{
  const { error } = await emp.rpc("fn_record_count_shortages", {
    p_snapshot_id: snapId, p_lines: [{ line_id: hookLine.id, reason: "nawala" }],
  });
  check("employee cannot post shortages", !!error && /owner/i.test(error.message), error?.message);
}

section("Shortage → loss queue:");
const { data: created, error: shortErr } = await owner.rpc("fn_record_count_shortages", {
  p_snapshot_id: snapId,
  p_lines: [
    { line_id: hookLine.id, reason: "nawala" },
    { line_id: floatLine.id, reason: "nawala" },  // exact match — must be skipped
    { line_id: sinkerLine.id, reason: "nawala" }, // counted MORE than expected — must be skipped
  ],
});
check("1 loss created (match + overage lines skipped)", !shortErr && created === 1,
  shortErr?.message ?? `created ${created}`);

const { data: loss } = await owner
  .from("losses")
  .select("id, qty, reason, status, shop_id, note, description")
  .eq("part_id", hooks.id)
  .eq("status", "pending")
  .single();
check("loss: qty 3, nawala, PENDING, right shop",
  loss?.qty === 3 && loss?.reason === "nawala" && loss?.shop_id === SHOP.id);
check("loss note carries expected/counted", /expected 12, counted 9/.test(loss?.note ?? ""),
  loss?.note);
{
  const { data: l } = await owner
    .from("count_snapshot_lines").select("shortage_loss_id").eq("id", hookLine.id).single();
  check("count line links to the loss it raised", l?.shortage_loss_id === loss?.id);
  const { data: ok } = await owner
    .from("count_snapshot_lines").select("shortage_loss_id").in("id", [floatLine.id, sinkerLine.id]);
  check("skipped lines raised no loss", (ok ?? []).every((r) => r.shortage_loss_id === null));
}
{
  const { data: again } = await owner.rpc("fn_record_count_shortages", {
    p_snapshot_id: snapId, p_lines: [{ line_id: hookLine.id, reason: "nawala" }],
  });
  check("idempotent: re-send creates 0", again === 0, `created ${again}`);
}
{
  const { data: v } = await emp.from("losses").select("id, status").eq("id", loss.id).single();
  check("employee sees the count loss in their submissions", !!v);
}
{
  check("posting a shortage does NOT itself deduct stock (still 12)", (await shopQty(hooks.id)) === 12);
}

section("Approve through the NORMAL queue:");
{
  const { error } = await owner.rpc("fn_approve_loss", { p_loss_id: loss.id, p_note: null });
  check("approval succeeded", !error, error?.message);
  check("shop stock 12 → 9 (deducted)", (await shopQty(hooks.id)) === 9);
  const { data: l2 } = await owner.from("losses").select("value_centavos, status").eq("id", loss.id).single();
  check("write-off valued at cost 3×₱5", Number(l2?.value_centavos) === 1500, `got ${l2?.value_centavos}`);
  check("loss now approved", l2?.status === "approved");
  const { data: moves } = await owner.from("stock_movements").select("movement_type, qty_change, shop_id")
    .eq("loss_id", loss.id);
  // A count shortage is a SHOP loss — not a transit write-off, not a return.
  check("ledger: one `loss` row, −3 at the shop",
    moves?.length === 1 && moves[0].movement_type === "loss"
      && moves[0].qty_change === -3 && moves[0].shop_id === SHOP.id,
    JSON.stringify(moves));
}
{
  const { error } = await owner.rpc("fn_approve_loss", { p_loss_id: loss.id, p_note: null });
  check("cannot approve the same loss twice", !!error && /already reviewed/i.test(error.message),
    error?.message);
}

section("Fractional counts on a `kg` product (0135):");
{
  const kgPart = await seedPart({ label: "KgCount", unit: "kg", cost: 1000, price: 2000 });
  await receive({ parts: [{ part_id: kgPart.id, qty: 10.25, unit_cost_centavos: 1000 }] });
  await deliverAndConfirm(SHOP, { parts: [{ part_id: kgPart.id, qty: 10.25 }] });
  check("shop holds 10.25 kg", (await shopQty(kgPart.id)) === 10.25);

  const { data: snap2Id, error: snap2Err } = await owner.rpc("fn_create_count_snapshot", {
    p_shop_id: SHOP.id, p_note: `ZZ-TEST fractional ${RUN}`,
  });
  check("second snapshot created", !snap2Err, snap2Err?.message);
  const { data: snap2Lines } = await owner
    .from("count_snapshot_lines").select("id, part_id, expected_qty").eq("snapshot_id", snap2Id);
  const kgLine = snap2Lines?.find((l) => l.part_id === kgPart.id);
  check("expected_qty froze at 10.25, not rounded to 10", Number(kgLine?.expected_qty) === 10.25,
    String(kgLine?.expected_qty));

  // exact match — this is precisely where the pre-0135 int cast rounded
  // 10.25 counted to 10, undercutting expected and inventing a shortage.
  {
    const { error } = await owner.rpc("fn_save_count", {
      p_snapshot_id: snap2Id, p_lines: [{ line_id: kgLine.id, counted_qty: 10.25 }],
    });
    check("fractional count saved", !error, error?.message);
    const { data: stored } = await owner
      .from("count_snapshot_lines").select("counted_qty").eq("id", kgLine.id).single();
    check("counted_qty stored as exactly 10.25, not rounded to 10",
      Number(stored?.counted_qty) === 10.25, String(stored?.counted_qty));

    const { data: created2, error: shortErr2 } = await owner.rpc("fn_record_count_shortages", {
      p_snapshot_id: snap2Id, p_lines: [{ line_id: kgLine.id, reason: "nawala" }],
    });
    check("no phantom loss on an exact fractional match", !shortErr2 && created2 === 0,
      shortErr2?.message ?? `created ${created2}`);
    const { data: noLoss } = await owner
      .from("losses").select("id").eq("part_id", kgPart.id).eq("status", "pending");
    check("no loss row exists for the kg part", (noLoss ?? []).length === 0);
  }

  // a genuine fractional shortage — 10.25 expected, 9.75 counted, short 0.5
  {
    const { error } = await owner.rpc("fn_save_count", {
      p_snapshot_id: snap2Id, p_lines: [{ line_id: kgLine.id, counted_qty: 9.75 }],
    });
    check("re-count saved", !error, error?.message);

    const { data: created3, error: shortErr3 } = await owner.rpc("fn_record_count_shortages", {
      p_snapshot_id: snap2Id, p_lines: [{ line_id: kgLine.id, reason: "nawala" }],
    });
    check("a genuine fractional shortage creates 1 loss", !shortErr3 && created3 === 1,
      shortErr3?.message ?? `created ${created3}`);

    const { data: kgLoss } = await owner
      .from("losses").select("qty, note").eq("part_id", kgPart.id).eq("status", "pending").single();
    check("loss qty is exactly 0.5, not rounded", Number(kgLoss?.qty) === 0.5, String(kgLoss?.qty));
    check("loss note carries expected/counted at two decimals",
      /expected 10\.25, counted 9\.75/.test(kgLoss?.note ?? ""), kgLoss?.note);
  }
}

section("Cleanup:");
await cleanup();
summary();
