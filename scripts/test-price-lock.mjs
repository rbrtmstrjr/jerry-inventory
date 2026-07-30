/**
 * 0100 — Price lock: cost + selling price are Gerry's after entry.
 *
 * The admin encodes prices once, at receiving/Add (INSERTs — untouched).
 * A BEFORE UPDATE trigger on parts + engines then refuses any change to the
 * two money columns unless the caller is the primary owner. It fires only
 * when a money column actually changes, so every other admin edit (names,
 * condition, photos) and every internal status write passes untouched.
 * The service role (auth.uid() IS NULL) stays exempt — tests and seeds.
 *
 * Refuses to run (exit 2) until 0100 is applied.
 */
import {
  owner, admin, signIn, RUN, check, section, summary,
  provisionShop, seedPart, seedEngineModel, trackEngine, cleanup,
} from "./_harness.mjs";

const ADMIN_EMAIL = `zz-lock-${RUN.toLowerCase()}@test.local`;
const ADMIN_PASSWORD = `Zz-test-${RUN}`;
let adminUserId = null;

try {
  // ── fixtures ──────────────────────────────────────────────────────────────
  await provisionShop("PriceLock"); // provisioned so cleanup scaffolding exists
  const part = await seedPart({ label: "PriceLock" });
  const model = await seedEngineModel({ model: `LOCK-${RUN}` });
  const { data: engine, error: engErr } = await admin.from("engines").insert({
    engine_model_id: model.id, serial_number: `ZZ-LOCK-${RUN}`,
    cost_centavos: 50000, price_centavos: 90000,
  }).select("id").single();
  if (engErr) throw new Error(`engine fixture: ${engErr.message}`);
  trackEngine(engine.id);

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: ADMIN_EMAIL, password: ADMIN_PASSWORD, email_confirm: true,
  });
  if (createErr) throw new Error(`fixture admin: ${createErr.message}`);
  adminUserId = created.user.id;
  await admin.from("profiles").insert({
    id: adminUserId, full_name: `ZZ-TEST Lock ${RUN}`, role: "admin", shop_id: null,
  });
  const adm = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

  // ── gate: the lock must exist. A trigger isn't API-visible, so the probe
  //    IS the behavior: if this admin price-edit succeeds, 0100 isn't applied.
  {
    const { error: probe } = await adm.from("parts")
      .update({ price_centavos: 99900 }).eq("id", part.id);
    if (!probe) {
      console.error("test-price-lock: migration 0100_price_lock.sql is not applied — run it in the SQL editor first.");
      if (adminUserId) await admin.auth.admin.deleteUser(adminUserId);
      await cleanup();
      process.exit(2);
    }
  }

  section("Admin: everything but money");
  {
    const { error } = await adm.from("parts")
      .update({ name: `ZZ-TEST PriceLock renamed ${RUN}` }).eq("id", part.id);
    check("admin edits a part's NAME", !error, error?.message);

    const { error: price } = await adm.from("parts")
      .update({ price_centavos: 99900 }).eq("id", part.id);
    check("admin CANNOT change a part's selling price",
      /only the owner can change/i.test(price?.message ?? ""), price?.message);

    const { error: cost } = await adm.from("parts")
      .update({ cost_centavos: 1 }).eq("id", part.id);
    check("admin CANNOT change a part's cost",
      /only the owner can change/i.test(cost?.message ?? ""), cost?.message);

    const { error: ePrice } = await adm.from("engines")
      .update({ price_centavos: 1 }).eq("id", engine.id);
    check("admin CANNOT change an engine's selling price",
      /only the owner can change/i.test(ePrice?.message ?? ""), ePrice?.message);

    const { error: eCond } = await adm.from("engines")
      .update({ condition: "second_hand" }).eq("id", engine.id);
    check("admin edits an engine's non-money fields", !eCond, eCond?.message);

    // both-at-once must not slip through either
    const { error: both } = await adm.from("parts")
      .update({ name: `ZZ-TEST x ${RUN}`, price_centavos: 88800 }).eq("id", part.id);
    check("a mixed update carrying a price change is refused whole",
      /only the owner can change/i.test(both?.message ?? ""), both?.message);
  }

  section("Gerry: unrestricted");
  {
    const { data, error } = await owner.from("parts")
      .update({ price_centavos: 35000 }).eq("id", part.id).select("price_centavos").single();
    check("owner changes a part's price", !error && data?.price_centavos === 35000, error?.message);

    const { data: e, error: eErr } = await owner.from("engines")
      .update({ price_centavos: 95000, cost_centavos: 52000 })
      .eq("id", engine.id).select("price_centavos").single();
    check("owner changes an engine's price AND cost", !eErr && e?.price_centavos === 95000, eErr?.message);
  }

  section("Service role: exempt (tests/seeds keep working)");
  {
    const { error } = await admin.from("parts")
      .update({ cost_centavos: 12000 }).eq("id", part.id);
    check("service role edits money columns freely", !error, error?.message);
  }

  section("No-change updates never trip the trigger");
  {
    // the exact shape an admin's Edit-dialog submit has after the server
    // strips the money fields — same values, other columns changing
    const { data: cur } = await admin.from("parts")
      .select("cost_centavos, price_centavos").eq("id", part.id).single();
    const { error } = await adm.from("parts")
      .update({
        notes: `ZZ-TEST note ${RUN}`,
        cost_centavos: cur.cost_centavos,
        price_centavos: cur.price_centavos,
      })
      .eq("id", part.id);
    check("admin submitting UNCHANGED money values passes (IS DISTINCT FROM)", !error, error?.message);
  }
} finally {
  if (adminUserId) await admin.auth.admin.deleteUser(adminUserId);
  await cleanup();
}
summary();
