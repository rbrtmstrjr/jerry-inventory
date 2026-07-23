/**
 * NOTIFICATION BACKFILL — raise the owner alerts the raw-inserted fixtures skipped.
 *
 * Notifications are event-driven and DEDUPED (fn_notify: at most one unread per
 * recipient+type+ref+shop), never one-per-transaction — normal sales/deliveries
 * never notify. seed-states.mjs created its in-flight states with raw inserts,
 * bypassing the RPCs that call fn_notify, so ~86 genuinely-actionable events
 * (discrepancies, transfer requests, warranty claims, overdue payables) produced
 * zero notifications. This raises them, mirroring fn_notify's exact shape (type
 * from the CHECK list, title/body wording, ref_table/ref_id, + an in_app
 * dispatch) so the bell reflects real activity. Idempotent: skips any (type,
 * ref_id) already notified.
 *
 *   Run after seed-states:  node scripts/seed-notifications.mjs
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const a = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const peso = (c) => "₱" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const { data: shopsRows } = await a.from("shops").select("id, name").is("deleted_at", null);
const shopName = new Map(shopsRows.map((s) => [s.id, s.name]));
const { data: chans } = await a.from("notification_channels").select("code").eq("enabled", true);
const enabledChannels = (chans ?? []).map((c) => c.code);

// existing (type|ref_id) so a re-run doesn't duplicate
const { data: existing } = await a.from("notifications").select("type, ref_id").is("deleted_at", null);
const seen = new Set((existing ?? []).map((r) => `${r.type}|${r.ref_id}`));

const notifs = [];
const push = (n) => { if (!n.ref_id || seen.has(`${n.type}|${n.ref_id}`)) return; seen.add(`${n.type}|${n.ref_id}`); notifs.push(n); };
const fetchAll = async (build) => { const out = []; for (let o = 0; ; o += 1000) { const { data } = await build().range(o, o + 999); out.push(...(data ?? [])); if ((data ?? []).length < 1000) return out; } };

// ── 1. delivery discrepancies (owner must resolve) ───────────────────────────
const disc = await a.from("deliveries").select("id, shop_id, confirmed_at, delivery_lines(qty, qty_received, qty_damaged)").eq("status", "discrepancy");
for (const d of disc.data ?? []) {
  let landed = 0, short = 0, damaged = 0;
  for (const l of d.delivery_lines ?? []) { landed += l.qty_received ?? 0; damaged += l.qty_damaged ?? 0; short += l.qty - (l.qty_received ?? 0); }
  push({
    recipient_role: "owner", shop_id: d.shop_id, type: "delivery_discrepancy",
    title: `${shopName.get(d.shop_id) ?? "A shop"}: ${short} item(s) need your decision`,
    body: `Received ${landed} good · ${damaged} damaged · ${short - damaged} missing — resolve the damaged & missing.`,
    ref_table: "deliveries", ref_id: d.id, created_at: d.confirmed_at,
  });
}

// ── 2. transfer requests (shop → shop, awaiting approval) ────────────────────
const tr = await a.from("deliveries").select("id, shop_id, from_shop_id, created_at, delivery_lines(id)").not("from_shop_id", "is", null).eq("status", "requested");
for (const d of tr.data ?? []) {
  push({
    recipient_role: "owner", shop_id: d.from_shop_id, type: "transfer_requested",
    title: "A shop wants to transfer stock",
    body: `${(d.delivery_lines ?? []).length} item(s) requested to move to ${shopName.get(d.shop_id) ?? "another shop"} — needs your approval.`,
    ref_table: "deliveries", ref_id: d.id, created_at: d.created_at,
  });
}

// ── 3. warranty claims (awaiting approval) ───────────────────────────────────
const wc = await a.from("warranty_claims").select("id, shop_id, resolution, created_at").eq("status", "requested");
for (const w of wc.data ?? []) {
  push({
    recipient_role: "owner", shop_id: w.shop_id, type: "warranty_claim",
    title: `Warranty claim (${w.resolution})`,
    body: "A shop filed a warranty claim awaiting your approval",
    ref_table: "warranty_claims", ref_id: w.id, created_at: w.created_at,
  });
}

// ── 4. overdue supplier payables ─────────────────────────────────────────────
const today = new Date().toISOString().slice(0, 10);
const od = await a.from("receivings").select("id, supplier_id, total_amount, amount_paid, due_date, suppliers(name)").neq("payment_status", "paid").lt("due_date", today);
for (const r of od.data ?? []) {
  const bal = r.total_amount - r.amount_paid;
  if (bal <= 0) continue;
  push({
    recipient_role: "owner", shop_id: null, type: "supplier_payment_overdue",
    title: `${r.suppliers?.name ?? "A supplier"} payment overdue`,
    body: `${peso(bal)} was due ${r.due_date} — settle it on Payables.`,
    ref_table: "receivings", ref_id: r.id, created_at: `${r.due_date}T09:00:00+08:00`,
  });
}

// ── 5. recent utang payments (owner alerted per payment) ─────────────────────
const up = await a.from("utang_payments").select("id, shop_id, amount_centavos, payer_name, created_at").eq("status", "approved").is("deleted_at", null).order("created_at", { ascending: false }).limit(20);
for (const p of up.data ?? []) {
  push({
    recipient_role: "owner", shop_id: p.shop_id, type: "utang_payment",
    title: `${peso(p.amount_centavos)} utang payment from ${p.payer_name ?? "a customer"}`,
    body: `${shopName.get(p.shop_id) ?? "A shop"} collected a balance payment.`,
    ref_table: "utang_payments", ref_id: p.id, created_at: p.created_at,
  });
}

// ── insert notifications + their in_app dispatches ───────────────────────────
if (!notifs.length) { console.log("Nothing to backfill — all events already notified."); process.exit(0); }
const { data: inserted, error } = await a.from("notifications").insert(notifs).select("id, type");
if (error) throw new Error(error.message);
if (enabledChannels.length) {
  const dispatches = inserted.flatMap((n) => enabledChannels.map((ch) => ({
    notification_id: n.id, channel: ch, status: ch === "in_app" ? "sent" : "pending",
    sent_at: ch === "in_app" ? new Date().toISOString() : null,
  })));
  await a.from("notification_dispatches").insert(dispatches);
}

const byType = {};
for (const n of inserted) byType[n.type] = (byType[n.type] ?? 0) + 1;
console.log(`Backfilled ${inserted.length} owner notifications:`);
for (const [t, n] of Object.entries(byType)) console.log(`  ${t.padEnd(26)} ${n}`);
const { count: unread } = await a.from("notifications").select("id", { count: "exact", head: true }).eq("recipient_role", "owner").is("read_at", null).is("deleted_at", null);
console.log(`\n  Owner bell now shows ${unread} unread.`);
