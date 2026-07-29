/**
 * 0050 — Shop colors.
 *
 * The color is a PALETTE KEY resolved to theme tokens at render — the schema
 * enforces the rest: only known keys (CHECK), unique among live shops
 * (partial unique index), released on close (soft-delete leaves the index),
 * nullable (neutral badge, nothing breaks).
 *
 * The suite is EXHAUSTION-AWARE: live shops can (and in production do) hold
 * all 10 palette keys, so a test shop may have no free color to claim. Every
 * guarantee is still provable — a full palette just proves uniqueness from
 * the other side (every key collides), and release-on-close is proved through
 * the partial index directly (a CLOSED shop may duplicate a live shop's color;
 * re-opening it while the color is taken is refused).
 */
import {
  owner, admin, check, section, summary, cleanup, provisionShop,
} from "./_harness.mjs";

// keep in sync with lib/shop-colors.ts (the CHECK constraint lists the same 10)
const PALETTE = [
  "amber", "emerald", "indigo", "lime", "orange",
  "rose", "sky", "slate", "teal", "violet",
];

const A = await provisionShop("ColorA");
const B = await provisionShop("ColorB");
const C = await provisionShop("ColorC");

const setColor = (client, id, color_key) =>
  client.from("shops").update({ color_key }).eq("id", id).select("color_key").maybeSingle();

// which keys are free among LIVE shops right now (our fixtures start null)
const { data: liveColored } = await admin
  .from("shops").select("color_key").is("deleted_at", null).not("color_key", "is", null);
const taken = new Set((liveColored ?? []).map((s) => s.color_key));
const free = PALETTE.filter((k) => !taken.has(k));

// ── 1. invalid keys rejected by the CHECK (testable regardless of exhaustion) ─
section("CHECK constraint");
{
  const { error: bad } = await setColor(owner, B.id, "hotpink");
  check("an unknown key is rejected by the CHECK", /shops_color_key_valid|check/i.test(bad?.message ?? ""), bad?.message);

  const { error: hex } = await setColor(owner, B.id, "#ff0000");
  check("a raw hex is rejected too (keys only, never values)", !!hex);
}

if (free.length >= 2) {
  // ── free colors exist: the straightforward claim/collide/release story ─────
  section(`Partial unique index (${free.length} free keys)`);
  {
    const { data, error } = await setColor(owner, A.id, free[0]);
    check("owner can set a palette key", !error && data?.color_key === free[0], error?.message);

    const { error: dup } = await setColor(owner, B.id, free[0]);
    check("duplicate color for a second live shop is rejected", dup?.code === "23505", dup?.message);

    const { error: ok } = await setColor(owner, B.id, free[1]);
    check("a different color is fine", !ok, ok?.message);
  }

  section("Release on close");
  {
    await admin.from("shops").update({ deleted_at: new Date().toISOString() }).eq("id", A.id);
    const { data, error } = await setColor(owner, C.id, free[0]);
    check(
      "a closed shop's color is reusable by a live one",
      !error && data?.color_key === free[0],
      error?.message
    );
    await admin.from("shops").update({ deleted_at: null, color_key: null }).eq("id", A.id);
    await setColor(owner, C.id, null);
  }
} else {
  // ── palette fully held by live shops: prove the same rules from the other side ─
  section("Partial unique index (palette fully held by live shops)");
  {
    let collisions = 0;
    for (const k of PALETTE) {
      const { error } = await setColor(owner, A.id, k);
      if (error?.code === "23505") collisions += 1;
    }
    check(
      "every palette key collides for a new live shop (uniqueness covers the whole palette)",
      collisions === PALETTE.length,
      `${collisions}/${PALETTE.length} collided`
    );
  }

  section("Release on close (via the partial index)");
  {
    // a CLOSED shop may hold a color a live shop also holds — the index only
    // binds live rows, which is exactly what "released on close" means
    await admin.from("shops").update({ deleted_at: new Date().toISOString() }).eq("id", A.id);
    const { data, error } = await admin.from("shops")
      .update({ color_key: PALETTE[0] }).eq("id", A.id).select("color_key").maybeSingle();
    check(
      "a closed shop may duplicate a live shop's color (index releases on close)",
      !error && data?.color_key === PALETTE[0],
      error?.message
    );

    const { error: revive } = await admin.from("shops")
      .update({ deleted_at: null }).eq("id", A.id);
    check(
      "re-opening it while the color is taken is refused (uniqueness re-binds)",
      revive?.code === "23505",
      revive?.message
    );
    await admin.from("shops").update({ deleted_at: null, color_key: null }).eq("id", A.id);
  }
}

// ── null = neutral, and employees can't recolor ─────────────────────────────
section("Null + RLS");
{
  const { error } = await setColor(owner, C.id, null);
  check("color can be cleared (neutral fallback)", !error, error?.message);

  // RLS filters the row BEFORE any constraint can fire: the employee's update
  // matches 0 rows (no error, no data) — a 23505 here would mean it got through
  const { data: bBefore } = await owner.from("shops").select("color_key").eq("id", B.id).single();
  const { data: empUpd, error: empErr } = await setColor(B.client, B.id, PALETTE[0]);
  const { data: after } = await owner.from("shops").select("color_key").eq("id", B.id).single();
  check(
    "employee cannot recolor their shop (RLS row filter, not a constraint error)",
    empErr?.code !== "23505" && !empUpd && after?.color_key === bBefore?.color_key,
    `color now ${after?.color_key}, employee update returned ${JSON.stringify(empUpd)} / ${empErr?.code}`
  );
}

await cleanup();
summary();
