/**
 * 0132 — Owner stock correction: Gerry fixes a wrong MASTER quantity himself.
 *
 * The number is set to what is actually there; the delta is written as a
 * `correction` movement so the ledger still explains the shelf. Refuses to run
 * (exit 2) until 0132 is applied.
 */
import {
  owner, admin, signIn, RUN, check, section, summary,
  provisionShop, seedPart, receive, deliverAndConfirm, cleanup,
} from "./_harness.mjs";

const ADMIN_EMAIL = `zz-corr-${RUN.toLowerCase()}@test.local`;
const ADMIN_PASSWORD = `Zz-test-${RUN}`;
let adminUserId = null;

const round2 = (n) => Math.round(n * 100) / 100;

const masterQty = async (partId) => {
  const { data } = await admin.from("stock_levels")
    .select("qty").eq("part_id", partId).is("shop_id", null).maybeSingle();
  return Number(data?.qty ?? 0);
};
// Sums with plain JS `+`, so the final total is rounded to two decimals —
// numeric(12,2) never has a third, and IEEE-754 can drift by 1e-16 (see the
// same class of bug in test-movements).
const masterLedger = async (partId) => {
  const { data } = await admin.from("stock_movements")
    .select("qty_change").eq("part_id", partId).is("shop_id", null);
  return round2((data ?? []).reduce((s, m) => s + Number(m.qty_change), 0));
};
const correct = (client, partId, qty, reason = `ZZ-TEST fix ${RUN}`) =>
  client.rpc("fn_correct_master_stock", {
    p_part_id: partId, p_new_qty: qty, p_reason: reason,
  });

try {
  const shop = await provisionShop("Correction");
  const part = await seedPart({ label: "Corr", unit: "pc" });
  const kgPart = await seedPart({ label: "CorrKg", unit: "kg" });
  // Never received — no master row exists for it. Exercises the
  // insert-if-missing branch (B5).
  const noStockPart = await seedPart({ label: "CorrNoStock", unit: "pc" });
  // reorder_level > 0 so a correction that drops it low enough raises a
  // master_low_stock alert (B6).
  const alertPart = await seedPart({ label: "CorrAlert", unit: "pc", reorder_level: 5 });
  const retPart = await seedPart({ label: "CorrRet", unit: "pc" });
  await receive({ parts: [{ part_id: part.id, qty: 10, unit_cost_centavos: 1000 }] });
  await receive({ parts: [{ part_id: kgPart.id, qty: 10, unit_cost_centavos: 1000 }] });
  await receive({ parts: [{ part_id: alertPart.id, qty: 10, unit_cost_centavos: 1000 }] });
  await receive({ parts: [{ part_id: retPart.id, qty: 10, unit_cost_centavos: 1000 }] });

  {
    const { data: noRow } = await admin.from("stock_levels")
      .select("qty").eq("part_id", noStockPart.id).is("shop_id", null).maybeSingle();
    check("a freshly seeded, never-received part has no master stock row", !noRow, JSON.stringify(noRow));
  }

  // ── gate ────────────────────────────────────────────────────────────────
  {
    const { data, error } = await correct(owner, part.id, 9);
    if (error && /Could not find the function|does not exist/i.test(error.message)) {
      console.error("test-stock-correction: migration 0132_owner_stock_correction.sql is not applied — run it in the SQL editor first.");
      await cleanup();
      process.exit(2);
    }
    check("owner can correct DOWN", !error, error?.message);
    check("the returned delta is -1", !error && Number(data) === -1, String(data));
    check("master is now 9", (await masterQty(part.id)) === 9);
  }

  section("The ledger still explains the shelf");
  {
    check("master ledger equals master shelf",
      (await masterLedger(part.id)) === (await masterQty(part.id)));
    const { data: mv } = await admin.from("stock_movements")
      .select("movement_type, qty_change, note")
      .eq("part_id", part.id).eq("movement_type", "correction").single();
    check("a correction movement was written", !!mv);
    check("its delta is -1", Number(mv?.qty_change) === -1, String(mv?.qty_change));
    check("the note carries the reason", (mv?.note ?? "").includes(RUN));
  }

  section("Corrections go both ways");
  {
    const { data, error } = await correct(owner, part.id, 14);
    check("owner can correct UP", !error, error?.message);
    check("the returned delta is +5", !error && Number(data) === 5, String(data));
    check("master is now 14", (await masterQty(part.id)) === 14);
    check("ledger still equals shelf", (await masterLedger(part.id)) === 14);
  }

  section("Return value (B3): the RPC returns the delta it applied");
  {
    const { data: down, error: dErr } = await correct(owner, retPart.id, 4);
    check("10 -> 4 succeeds", !dErr, dErr?.message);
    check("10 -> 4 returns -6", !dErr && Number(down) === -6, String(down));
    check("master reflects 4", (await masterQty(retPart.id)) === 4);

    const { data: up, error: uErr } = await correct(owner, retPart.id, 9);
    check("4 -> 9 succeeds", !uErr, uErr?.message);
    check("4 -> 9 returns +5", !uErr && Number(up) === 5, String(up));
    check("master reflects 9", (await masterQty(retPart.id)) === 9);
  }

  section("Validation");
  {
    const { error: same } = await correct(owner, part.id, 14);
    check("a no-op correction is refused", !!same, "delta 0 should raise");
    check("...naming that it's already that quantity",
      /is already/i.test(same?.message ?? ""), same?.message);

    const { error: neg } = await correct(owner, part.id, -1);
    check("a negative quantity is refused", !!neg);
    check("...for being negative, not some other reason",
      /more than zero/i.test(neg?.message ?? ""), neg?.message);

    const { error: frac } = await correct(owner, part.id, 2.5);
    check("a `pc` product refuses a fraction", !!frac, frac?.message);
    check("...because pc is not fractional, not some other reason",
      /measured in/i.test(frac?.message ?? ""), frac?.message);

    const { error: kgOk } = await correct(owner, kgPart.id, 2.5);
    check("a `kg` product accepts a tenth", !kgOk, kgOk?.message);

    const { data: hundredths, error: hErr } = await correct(owner, kgPart.id, 1.25);
    check("a `kg` product accepts hundredths", !hErr, hErr?.message);
    check("...and the delta reflects the precise value",
      !hErr && Number(hundredths) === -1.25, String(hundredths));
    check("master reflects 1.25 exactly", (await masterQty(kgPart.id)) === 1.25);

    const { error: tooPrecise } = await correct(owner, kgPart.id, 1.255);
    check("three decimals are refused", !!tooPrecise);
    check("...for having too many decimals, not some other reason",
      /too many decimals/i.test(tooPrecise?.message ?? ""), tooPrecise?.message);

    const { error: noReason } = await correct(owner, part.id, 3, "   ");
    check("an empty reason is refused", !!noReason);
    check("...naming the missing reason, not some other error",
      /give a reason/i.test(noReason?.message ?? ""), noReason?.message);
    check("master unchanged after every refusal", (await masterQty(part.id)) === 14);
  }

  section("Authority: Gerry alone");
  {
    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email: ADMIN_EMAIL, password: ADMIN_PASSWORD, email_confirm: true,
    });
    if (cErr) throw new Error(`fixture admin: ${cErr.message}`);
    adminUserId = created.user.id;
    await admin.from("profiles").insert({
      id: adminUserId, full_name: `ZZ-TEST Corr Admin ${RUN}`, role: "admin", shop_id: null,
    });
    const adm = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

    const { error: admErr } = await correct(adm, part.id, 2);
    check("admin is refused", !!admErr, admErr?.message);
    check("...by name, not an incidental error",
      /only the owner/i.test(admErr?.message ?? ""), admErr?.message);

    const { error: empErr } = await correct(shop.client, part.id, 2);
    check("employee is refused", !!empErr);
    check("...by name, not an incidental error",
      /only the owner/i.test(empErr?.message ?? ""), empErr?.message);

    check("master still 14 after refusals", (await masterQty(part.id)) === 14);
  }

  section("Shop stock is untouched");
  {
    await deliverAndConfirm(shop, { parts: [{ part_id: part.id, qty: 4 }] });
    const { data: before } = await admin.from("stock_levels")
      .select("qty").eq("part_id", part.id).eq("shop_id", shop.id).single();

    const { data, error } = await correct(owner, part.id, 1);
    check("owner corrects master again", !error, error?.message);
    check("the returned delta is -9", !error && Number(data) === -9, String(data));

    const { data: after } = await admin.from("stock_levels")
      .select("qty").eq("part_id", part.id).eq("shop_id", shop.id).single();
    check("the shop's quantity did not move",
      Number(before.qty) === Number(after.qty), `${before?.qty} -> ${after?.qty}`);
    check("master is 1", (await masterQty(part.id)) === 1);
  }

  section("Correcting to zero — the motivating case (B4)");
  {
    const { data, error } = await correct(owner, part.id, 0);
    check("owner corrects master to zero", !error, error?.message);
    check("the returned delta is -1", !error && Number(data) === -1, String(data));
    check("master is now 0", (await masterQty(part.id)) === 0);
    check("master ledger sums to 0", (await masterLedger(part.id)) === 0);

    const { data: shopLvl } = await admin.from("stock_levels")
      .select("qty").eq("part_id", part.id).eq("shop_id", shop.id).single();
    check("the shop's quantity is still untouched (4)", Number(shopLvl?.qty) === 4, String(shopLvl?.qty));
  }

  section("No master stock row — the insert-if-missing branch (B5)");
  {
    const { data, error } = await correct(owner, noStockPart.id, 6);
    check("correcting a part with no master row succeeds", !error, error?.message);
    check("the returned delta is +6", !error && Number(data) === 6, String(data));
    check("master now holds 6", (await masterQty(noStockPart.id)) === 6);
    check("ledger equals shelf", (await masterLedger(noStockPart.id)) === 6);
  }

  section("The alert hook sees the corrected quantity (B6)");
  {
    // 10 on hand, reorder at 5 — no alert yet.
    const { count: before } = await admin.from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("type", "master_low_stock").eq("ref_id", alertPart.id);
    check("no low-stock alert before the correction", (before ?? 0) === 0, `found ${before}`);

    const { error } = await correct(owner, alertPart.id, 3, `ZZ-TEST low ${RUN}`);
    check("correcting below reorder_level succeeds", !error, error?.message);
    check("master is now 3", (await masterQty(alertPart.id)) === 3);

    const { data: notif, error: nErr } = await admin.from("notifications")
      .select("id, recipient_role, shop_id, read_at")
      .eq("type", "master_low_stock").eq("ref_id", alertPart.id)
      .eq("ref_table", "parts").maybeSingle();
    check("the notification query succeeded", !nErr, nErr?.message);
    check("a master_low_stock notification now exists for it", !!notif);
    check("...addressed to the owner, not a shop",
      notif?.recipient_role === "owner" && notif?.shop_id === null);
    check("...and unread", notif?.read_at === null);
  }

  section("No shrinkage is invented");
  {
    const { count, error } = await admin.from("losses")
      .select("id", { count: "exact", head: true }).eq("part_id", part.id);
    check("the losses query succeeded", !error, error?.message);
    check("no loss row was created", !error && (count ?? 0) === 0, `found ${count}`);
  }
} finally {
  // cleanup() FIRST — if deleteUser rejects, every fixture still gets swept.
  // This admin never writes an attribution row (every correct() call it made
  // was refused before any write), so the reverse order carries no FK risk
  // either way; this is still the safer default (see test-catalog-retire-lock).
  await cleanup();
  if (adminUserId) {
    const { error } = await admin.auth.admin.deleteUser(adminUserId);
    check("cleanup: fixture admin login removed", !error, error?.message);
  }
}
summary();
