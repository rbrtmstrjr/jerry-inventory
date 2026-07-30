/**
 * 0102 — Catalog retire & merge lock: removing a product is Gerry's alone.
 *
 * A retire is the one catalog action that REMOVES EVIDENCE — the product
 * vanishes from every screen while its ledger history stays behind as tolerated
 * debris. A merge additionally redirects the source's supplier prices onto
 * another product. 0100 locked the numbers; this locks the disappearing.
 *
 * THE SUITE'S REAL JOB is the "admin keeps working" section. deleted_at is not
 * price_centavos: FOUR definer functions soft-delete an engine at FIVE sites as
 * normal operations (fn_approve_loss, fn_resolve_delivery_discrepancy,
 * fn_return_stock, fn_approve_return), and SECURITY DEFINER does not change
 * auth.uid() — so a naive blanket trigger would break loss approval,
 * discrepancy resolution and return approval for the admin. The lock therefore
 * fires only for an engine still `in_master`, and this suite proves all three
 * operational paths still run as the admin.
 *
 * Refuses to run (exit 2) until 0102 is applied.
 */
import {
  owner, admin, anonClient, signIn, RUN, check, section, summary,
  provisionShop, seedPart, seedEngineModel,
  trackPart, trackEngineModel, trackEngine, cleanup,
} from "./_harness.mjs";

const ADMIN_EMAIL = `zz-retire-${RUN.toLowerCase()}@test.local`;
const ADMIN_PASSWORD = `Zz-test-${RUN}`;
let adminUserId = null;
let categoryId = null;   // our own fixture category — never a real one
let mergeCategoryId = null;

/** Insert an engine straight into master (fixtures aren't receivings — 0049). */
async function seedEngine(modelId, serialSuffix) {
  const { data, error } = await admin.from("engines").insert({
    engine_model_id: modelId,
    serial_number: `ZZ-RET-${serialSuffix}-${RUN}`,
    cost_centavos: 40000, price_centavos: 80000,
  }).select("id, status").single();
  if (error) throw new Error(`engine fixture ${serialSuffix}: ${error.message}`);
  trackEngine(data.id);
  return data;
}

/** Is this row still live? The error alone proves nothing — read it back. */
async function stillLive(table, id) {
  const { data } = await admin.from(table)
    .select("deleted_at").eq("id", id).single();
  return data?.deleted_at === null;
}

try {
  // ── fixtures ──────────────────────────────────────────────────────────────
  const shop = await provisionShop("RetireLock");
  const model = await seedEngineModel({ model: `RET-${RUN}` });

  const part = await seedPart({ label: "RetireLock" });
  const partForDelete = await seedPart({ label: "RetireHardDel" });
  const partGerry = await seedPart({ label: "RetireGerry" });
  const mergeSource = await seedPart({ label: "MergeSrc" });
  const mergeTarget = await seedPart({ label: "MergeTgt" });

  // a category of our own: retiring a REAL one would damage live data
  {
    const { data, error } = await admin.from("product_categories")
      .insert({ name: `ZZ-TEST RetireCat ${RUN}` }).select("id").single();
    if (error) throw new Error(`category fixture: ${error.message}`);
    categoryId = data.id;
    const { data: d2, error: e2 } = await admin.from("product_categories")
      .insert({ name: `ZZ-TEST RetireCat2 ${RUN}` }).select("id").single();
    if (e2) throw new Error(`category fixture 2: ${e2.message}`);
    mergeCategoryId = d2.id;
  }

  const modelForDelete = await seedEngineModel({ model: `RETDEL-${RUN}` });
  const modelGerry = await seedEngineModel({ model: `RETG-${RUN}` });

  const engInMaster = await seedEngine(model.id, "MASTER");
  const engForDelete = await seedEngine(model.id, "HARDDEL");
  const engGerry = await seedEngine(model.id, "GERRY");
  const engLoss = await seedEngine(model.id, "LOSS");
  const engTransit = await seedEngine(model.id, "TRANSIT");
  const engReturn = await seedEngine(model.id, "RETURN");

  // fixture admin (office tier)
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: ADMIN_EMAIL, password: ADMIN_PASSWORD, email_confirm: true,
  });
  if (createErr) throw new Error(`fixture admin: ${createErr.message}`);
  adminUserId = created.user.id;
  await admin.from("profiles").insert({
    id: adminUserId, full_name: `ZZ-TEST Retire ${RUN}`, role: "admin", shop_id: null,
  });
  const adm = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

  // ── gate: the lock must exist. A trigger isn't API-visible, so the probe IS
  //    the behavior: if this admin retire succeeds, 0102 isn't applied.
  {
    const { error: probe } = await adm.from("parts")
      .update({ deleted_at: new Date().toISOString() }).eq("id", part.id);
    if (!probe) {
      console.error(
        "test-catalog-retire-lock: migration 0102_catalog_retire_lock.sql is not applied — run it in the SQL editor first."
      );
      await cleanup();   // same order as the finally block — see the note there
      if (categoryId) await admin.from("product_categories").delete().eq("id", categoryId);
      if (mergeCategoryId) await admin.from("product_categories").delete().eq("id", mergeCategoryId);
      if (adminUserId) await admin.auth.admin.deleteUser(adminUserId);
      process.exit(2);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  section("Admin is refused: retire");
  // ────────────────────────────────────────────────────────────────────────────
  {
    const { error } = await adm.from("parts")
      .update({ deleted_at: new Date().toISOString() }).eq("id", part.id);
    check("admin CANNOT retire a part",
      /only the owner can retire/i.test(error?.message ?? ""), error?.message);
    check("...and the part is still live afterward", await stillLive("parts", part.id));

    // merged_into on its own, deleted_at untouched — the silent price redirect
    const { error: redirect } = await adm.from("parts")
      .update({ merged_into: mergeTarget.id }).eq("id", part.id);
    check("admin CANNOT redirect merged_into with no deleted_at",
      /only the owner can merge/i.test(redirect?.message ?? ""), redirect?.message);
    const { data: after } = await admin.from("parts")
      .select("merged_into, deleted_at").eq("id", part.id).single();
    check("...and merged_into is still null, part still live",
      after?.merged_into === null && after?.deleted_at === null);

    const { error: em } = await adm.from("engine_models")
      .update({ deleted_at: new Date().toISOString() }).eq("id", model.id);
    check("admin CANNOT retire an engine model",
      /only the owner can retire/i.test(em?.message ?? ""), em?.message);
    check("...and the model is still live", await stillLive("engine_models", model.id));

    const { error: cat } = await adm.from("product_categories")
      .update({ deleted_at: new Date().toISOString() }).eq("id", categoryId);
    check("admin CANNOT retire a product category",
      /only the owner can retire/i.test(cat?.message ?? ""), cat?.message);
    check("...and the category is still live", await stillLive("product_categories", categoryId));

    const { error: eng } = await adm.from("engines")
      .update({ deleted_at: new Date().toISOString() }).eq("id", engInMaster.id);
    check("admin CANNOT remove an IN-MASTER engine from the catalog",
      /only the owner can remove an engine/i.test(eng?.message ?? ""), eng?.message);
    check("...and the serial is still live", await stillLive("engines", engInMaster.id));
  }

  section("Admin is refused: fn_merge_parts");
  {
    const { error } = await adm.rpc("fn_merge_parts", {
      p_source_id: mergeSource.id, p_target_id: mergeTarget.id, p_note: null,
    });
    check("admin CANNOT call fn_merge_parts",
      /only the owner can merge products/i.test(error?.message ?? ""), error?.message);
    const { data: src } = await admin.from("parts")
      .select("merged_into, deleted_at").eq("id", mergeSource.id).single();
    check("...and the source is still live, still unmerged",
      src?.deleted_at === null && src?.merged_into === null);
  }

  section("Admin is refused: hard DELETE (grant revoked)");
  {
    // history-less fixtures on purpose — a row with FK references would fail
    // for the wrong reason and prove nothing about the grant
    const { error: p } = await adm.from("parts").delete().eq("id", partForDelete.id);
    check("hard DELETE on parts is refused",
      /permission denied/i.test(p?.message ?? ""), p?.message);
    check("...and the part still exists", await stillLive("parts", partForDelete.id));

    const { error: e } = await adm.from("engines").delete().eq("id", engForDelete.id);
    check("hard DELETE on engines is refused",
      /permission denied/i.test(e?.message ?? ""), e?.message);

    const { error: m } = await adm.from("engine_models").delete().eq("id", modelForDelete.id);
    check("hard DELETE on engine_models is refused",
      /permission denied/i.test(m?.message ?? ""), m?.message);

    const { error: c } = await adm.from("product_categories").delete().eq("id", mergeCategoryId);
    check("hard DELETE on product_categories is refused",
      /permission denied/i.test(c?.message ?? ""), c?.message);
  }

  // ────────────────────────────────────────────────────────────────────────────
  section("Admin KEEPS WORKING — ordinary catalog edits");
  // ────────────────────────────────────────────────────────────────────────────
  {
    const { error } = await adm.from("parts").update({
      name: `ZZ-TEST RetireLock renamed ${RUN}`,
      sku: `ZZ-SKU-${RUN}`,
      notes: `ZZ-TEST note ${RUN}`,
      reorder_level: 7,
      category_id: categoryId,
    }).eq("id", part.id);
    check("admin edits a part's name/SKU/notes/reorder/category", !error, error?.message);

    const { error: cond } = await adm.from("engines")
      .update({ condition: "second_hand" }).eq("id", engInMaster.id);
    check("admin edits an engine's condition", !cond, cond?.message);

    const { error: hp } = await adm.from("engine_models")
      .update({ horsepower: 25 }).eq("id", model.id);
    check("admin edits an engine model's horsepower", !hp, hp?.message);

    const { error: rename } = await adm.from("product_categories")
      .update({ name: `ZZ-TEST RetireCat renamed ${RUN}` }).eq("id", categoryId);
    check("admin renames a category", !rename, rename?.message);
  }

  section("Admin KEEPS WORKING — the null → not-null gate, not a blanket check");
  {
    // the exact shape a PATCH has when deleted_at rides along unchanged
    const { error } = await adm.from("parts")
      .update({ notes: `ZZ-TEST carried ${RUN}`, deleted_at: null })
      .eq("id", part.id);
    check("an UPDATE carrying deleted_at UNCHANGED (still null) passes",
      !error, error?.message);
  }

  section("Admin KEEPS WORKING — the four operational engine soft-deletes");
  {
    // (a) approved LOSS on a DELIVERED engine  (fn_approve_loss, 0008:186)
    const delId = await (async () => {
      const { data: id, error } = await owner.rpc("fn_deliver_stock", {
        p_shop_id: shop.id, p_note: `ZZ-TEST loss dlv ${RUN}`,
        p_parts: [], p_engine_ids: [engLoss.id],
      });
      if (error) throw new Error(`deliver engLoss: ${error.message}`);
      const { data: lines } = await owner.from("delivery_lines")
        .select("id, qty").eq("delivery_id", id);
      const { error: cErr } = await shop.client.rpc("fn_confirm_delivery", {
        p_delivery_id: id,
        p_lines: lines.map((l) => ({ line_id: l.id, qty_received: l.qty })),
        p_note: null,
      });
      if (cErr) throw new Error(`confirm engLoss: ${cErr.message}`);
      return id;
    })();
    void delId;

    const { data: lossId, error: lErr } = await shop.client.rpc("fn_record_loss", {
      p_part_id: null, p_engine_id: engLoss.id, p_qty: 1,
      p_reason: "nasira", p_note: `ZZ-TEST loss ${RUN}`,
    });
    if (lErr) throw new Error(`record_loss: ${lErr.message}`);
    await shop.client.rpc("fn_submit_shop_batch");

    const { error: apprErr } = await adm.rpc("fn_approve_loss", {
      p_loss_id: lossId, p_note: null,
    });
    check("admin approves a loss on a DELIVERED engine (no raise)",
      !apprErr, apprErr?.message);
    check("...and the serial was soft-deleted by the definer",
      !(await stillLive("engines", engLoss.id)));

    // (b) transit WRITE-OFF of an IN_TRANSIT engine
    //     (fn_resolve_delivery_discrepancy, 0054:383)
    const { data: tId, error: tErr } = await owner.rpc("fn_deliver_stock", {
      p_shop_id: shop.id, p_note: `ZZ-TEST transit ${RUN}`,
      p_parts: [], p_engine_ids: [engTransit.id],
    });
    if (tErr) throw new Error(`deliver engTransit: ${tErr.message}`);
    const { data: tLines } = await owner.from("delivery_lines")
      .select("id").eq("delivery_id", tId);
    const { error: tcErr } = await shop.client.rpc("fn_confirm_delivery", {
      p_delivery_id: tId,
      p_lines: tLines.map((l) => ({ line_id: l.id, qty_received: 0 })),
      p_note: `ZZ-TEST never arrived ${RUN}`,
    });
    if (tcErr) throw new Error(`confirm 0: ${tcErr.message}`);

    const { error: resErr } = await adm.rpc("fn_resolve_delivery_discrepancy", {
      p_delivery_line_id: tLines[0].id, p_qty: 1,
      p_resolution: "written_off", p_reason: "lost_in_transit",
    });
    check("admin writes off an IN_TRANSIT engine (no raise)", !resErr, resErr?.message);
    check("...and the serial was soft-deleted by the definer",
      !(await stillLive("engines", engTransit.id)));

    // (c) shop RETURN with a damaged engine (fn_approve_return, 0065:217)
    const { data: rId, error: rErr } = await owner.rpc("fn_deliver_stock", {
      p_shop_id: shop.id, p_note: `ZZ-TEST ret dlv ${RUN}`,
      p_parts: [], p_engine_ids: [engReturn.id],
    });
    if (rErr) throw new Error(`deliver engReturn: ${rErr.message}`);
    const { data: rLines } = await owner.from("delivery_lines")
      .select("id, qty").eq("delivery_id", rId);
    const { error: rcErr } = await shop.client.rpc("fn_confirm_delivery", {
      p_delivery_id: rId,
      p_lines: rLines.map((l) => ({ line_id: l.id, qty_received: l.qty })),
      p_note: null,
    });
    if (rcErr) throw new Error(`confirm engReturn: ${rcErr.message}`);

    const { data: retId, error: reqErr } = await shop.client.rpc("fn_request_return", {
      p_reason: `ZZ-TEST damaged ${RUN}`,
      p_parts: [],
      p_engine_ids: [{ engine_id: engReturn.id, condition: "damaged" }],
    });
    if (reqErr) throw new Error(`request_return: ${reqErr.message}`);

    const { error: appErr } = await adm.rpc("fn_approve_return", { p_return_id: retId });
    check("admin approves a return with a DAMAGED engine (no raise)",
      !appErr, appErr?.message);
    check("...and the serial was soft-deleted by the definer",
      !(await stillLive("engines", engReturn.id)));
  }

  section("Admin KEEPS WORKING — creation (0049 path) + restore");
  {
    const { data: rcv, error } = await adm.rpc("fn_receive_stock", {
      p_supplier_id: null,
      p_note: `ZZ-TEST admin inline ${RUN}`,
      p_parts: [{
        qty: 2, unit_cost_centavos: 1500,
        new_part: { name: `ZZ-TEST InlinePart ${RUN}`, price_centavos: 3000 },
      }],
      p_engines: [{
        serial_number: `ZZ-RET-INLINE-${RUN}`,
        cost_centavos: 20000, price_centavos: 45000,
        new_model: { brand: "ZZ-TEST", model: `INLINE-${RUN}` },
      }],
    });
    check("admin still creates a part + engine + model inline via fn_receive_stock",
      !error, error?.message);
    if (rcv) {
      const { data: lines } = await admin.from("receiving_lines")
        .select("part_id, engine_id").eq("receiving_id", rcv);
      for (const l of lines ?? []) {
        if (l.part_id) trackPart(l.part_id);
        if (l.engine_id) {
          trackEngine(l.engine_id);
          const { data: e } = await admin.from("engines")
            .select("engine_model_id").eq("id", l.engine_id).single();
          if (e) trackEngineModel(e.engine_model_id);
        }
      }
    }

    // restore is NOT the cheat — it makes something visible again. This is the
    // DB write behind createCategory's "an existing retired name is restored".
    await admin.from("product_categories")
      .update({ deleted_at: new Date().toISOString() }).eq("id", mergeCategoryId);
    const { error: restore } = await adm.from("product_categories")
      .update({ deleted_at: null }).eq("id", mergeCategoryId);
    check("admin RESTORES a retired category (deleted_at → null) — not blocked",
      !restore, restore?.message);
    check("...and it is live again", await stillLive("product_categories", mergeCategoryId));

    await admin.from("parts")
      .update({ deleted_at: new Date().toISOString() }).eq("id", partForDelete.id);
    const { error: rp } = await adm.from("parts")
      .update({ deleted_at: null }).eq("id", partForDelete.id);
    check("admin RESTORES a retired part — not blocked", !rp, rp?.message);
  }

  // ────────────────────────────────────────────────────────────────────────────
  section("Gerry is unrestricted");
  // ────────────────────────────────────────────────────────────────────────────
  {
    const { error: p } = await owner.from("parts")
      .update({ deleted_at: new Date().toISOString() }).eq("id", partGerry.id);
    check("owner retires a part", !p, p?.message);
    check("...and it is retired", !(await stillLive("parts", partGerry.id)));

    const { error: e } = await owner.from("engines")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", engGerry.id).eq("status", "in_master");
    check("owner removes an IN-MASTER engine", !e, e?.message);
    check("...and it is retired", !(await stillLive("engines", engGerry.id)));

    const { error: m } = await owner.from("engine_models")
      .update({ deleted_at: new Date().toISOString() }).eq("id", modelGerry.id);
    check("owner retires an engine model", !m, m?.message);

    const { error: c } = await owner.from("product_categories")
      .update({ deleted_at: new Date().toISOString() }).eq("id", categoryId);
    check("owner retires a category", !c, c?.message);
    // put it back — `part` still references it and cleanup deletes parts first
    await admin.from("product_categories").update({ deleted_at: null }).eq("id", categoryId);
  }

  section("Gerry: fn_merge_parts end-to-end");
  {
    // a fitment on the source must survive on the target
    await admin.from("part_fitments")
      .insert({ part_id: mergeSource.id, engine_model_id: model.id });

    const { error } = await owner.rpc("fn_merge_parts", {
      p_source_id: mergeSource.id, p_target_id: mergeTarget.id,
      p_note: `ZZ-TEST merge ${RUN}`,
    });
    check("owner merges a duplicate into a survivor", !error, error?.message);

    const { data: src } = await admin.from("parts")
      .select("merged_into, deleted_at").eq("id", mergeSource.id).single();
    check("source carries merged_into + deleted_at",
      src?.merged_into === mergeTarget.id && src?.deleted_at !== null);

    const { data: audit } = await admin.from("part_merges")
      .select("source_part_id, target_part_id").eq("source_part_id", mergeSource.id);
    check("part_merges audit row written",
      (audit ?? []).length === 1 && audit[0].target_part_id === mergeTarget.id);

    const { data: levels } = await admin.from("stock_levels")
      .select("id").eq("part_id", mergeSource.id);
    check("source's stock_levels rows dropped", (levels ?? []).length === 0);

    const { data: fits } = await admin.from("part_fitments")
      .select("engine_model_id").eq("part_id", mergeTarget.id);
    check("fitment carried forward to the survivor",
      (fits ?? []).some((f) => f.engine_model_id === model.id));
  }

  section("Service role stays exempt (every suite's cleanup depends on it)");
  {
    const { error } = await admin.from("parts")
      .update({ deleted_at: new Date().toISOString() }).eq("id", part.id);
    check("service role sets deleted_at freely", !error, error?.message);
    await admin.from("parts").update({ deleted_at: null }).eq("id", part.id);

    const throwaway = await seedPart({ label: "SvcHardDel" });
    const { error: del } = await admin.from("parts").delete().eq("id", throwaway.id);
    check("service role hard-deletes a fixture row", !del, del?.message);
  }

  section("Employee and anon: unchanged (no reach at all)");
  {
    const anon = anonClient();
    for (const [label, client] of [["employee", shop.client], ["anon", anon]]) {
      const { data: read } = await client.from("parts").select("id").limit(1);
      check(`${label} cannot read parts`, (read ?? []).length === 0);

      // Two different refusals, both valid: anon is refused by GRANT (error),
      // while an employee is refused by RLS — `engine_models_write` uses
      // is_owner(), so the row is invisible to the UPDATE and PostgREST
      // reports success with ZERO rows affected. The trigger never even fires.
      // What matters is that nothing was retired, so accept either shape.
      const { data: rows, error: w } = await client.from("engine_models")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", model.id).select("id");
      check(`${label} cannot retire an engine model`,
        !!w || (rows ?? []).length === 0, w?.message ?? `${rows?.length} row(s) affected`);
      check(`...and the model is still live (${label})`,
        await stillLive("engine_models", model.id));

      const { error: rpc } = await client.rpc("fn_merge_parts", {
        p_source_id: partGerry.id, p_target_id: mergeTarget.id, p_note: null,
      });
      check(`${label} cannot call fn_merge_parts`, !!rpc, rpc?.message);
    }
  }
} finally {
  // ORDER MATTERS. cleanup() FIRST, the auth user LAST.
  //
  // This suite's fixture admin actually WORKS — it approves a loss, resolves a
  // write-off, approves a return and runs fn_receive_stock. Every one of those
  // stamps attribution on a row that FKs public.profiles (stock_movements.actor,
  // losses.reviewed_by, returns.approved_by, deliveries.resolved_by,
  // receivings.created_by). Deleting the auth user cascades to profiles
  // (0001), so while any of those rows survive the cascade is FK-BLOCKED and
  // the user is silently left behind in a live project — exactly what the
  // harness rules exist to prevent. (test-price-lock uses the opposite order
  // safely only because its admin never writes attribution.)
  await cleanup();
  // categories aren't harness-tracked — sweep our own, after parts are gone
  for (const id of [categoryId, mergeCategoryId]) {
    if (id) await admin.from("product_categories").delete().eq("id", id);
  }
  if (adminUserId) {
    const { error } = await admin.auth.admin.deleteUser(adminUserId);
    // never fail silently again — a leftover fixture login must be loud
    check("cleanup: fixture admin login removed", !error, error?.message);
  }
}
summary();
