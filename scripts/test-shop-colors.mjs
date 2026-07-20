/**
 * 0050 — Shop colors.
 *
 * The color is a PALETTE KEY resolved to theme tokens at render — the schema
 * enforces the rest: only known keys (CHECK), unique among live shops
 * (partial unique index), released on close (soft-delete leaves the index),
 * nullable (neutral badge, nothing breaks).
 */
import {
  owner, admin, check, section, summary, cleanup, provisionShop,
} from "./_harness.mjs";

const A = await provisionShop("ColorA");
const B = await provisionShop("ColorB");
const C = await provisionShop("ColorC");

const setColor = (client, id, color_key) =>
  client.from("shops").update({ color_key }).eq("id", id).select("color_key").maybeSingle();

// ── 1. valid keys in, invalid keys rejected by the CHECK ─────────────────────
section("CHECK constraint");
{
  const { data, error } = await setColor(owner, A.id, "teal");
  check("owner can set a palette key", !error && data?.color_key === "teal", error?.message);

  const { error: bad } = await setColor(owner, B.id, "hotpink");
  check("an unknown key is rejected by the CHECK", /shops_color_key_valid|check/i.test(bad?.message ?? ""), bad?.message);

  const { error: hex } = await setColor(owner, B.id, "#ff0000");
  check("a raw hex is rejected too (keys only, never values)", !!hex);
}

// ── 2. uniqueness among LIVE shops, enforced at the database ────────────────
section("Partial unique index");
{
  const { error } = await setColor(owner, B.id, "teal");
  check("duplicate color for a second live shop is rejected", error?.code === "23505", error?.message);

  const { error: ok } = await setColor(owner, B.id, "amber");
  check("a different color is fine", !ok, ok?.message);
}

// ── 3. closing a shop releases its color ─────────────────────────────────────
section("Release on close");
{
  await admin.from("shops").update({ deleted_at: new Date().toISOString() }).eq("id", A.id);
  const { data, error } = await setColor(owner, C.id, "teal");
  check(
    "a closed shop's color is reusable by a live one",
    !error && data?.color_key === "teal",
    error?.message
  );
  // reopen A so harness cleanup sees a normal shop (it hard-deletes anyway)
  await admin.from("shops").update({ deleted_at: null, color_key: null }).eq("id", A.id);
}

// ── 4. null = neutral, and employees can't recolor ──────────────────────────
section("Null + RLS");
{
  const { data, error } = await setColor(owner, C.id, null);
  check("color can be cleared (neutral fallback)", !error && data?.color_key === null, error?.message);

  const { data: empUpd } = await setColor(B.client, B.id, "rose");
  const { data: after } = await owner.from("shops").select("color_key").eq("id", B.id).single();
  check(
    "employee cannot recolor their shop (RLS)",
    after?.color_key === "amber",
    `color now ${after?.color_key}, employee update returned ${JSON.stringify(empUpd)}`
  );
}

await cleanup();
summary();
