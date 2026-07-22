/**
 * Shared test harness.
 *
 * WHY THIS EXISTS
 * The seeded shop logins (branch1@jerrysmarine.test â€¦) were replaced with real
 * ones when the app went live, which killed every employee-side script at
 * sign-in. Worse, the old scripts hardcoded the seed shop UUIDs â€” which are now
 * the REAL Branch 1 / Branch 2 â€” so they wrote test stock into live shops.
 *
 * Every script therefore PROVISIONS ITS OWN shop + employee via the service
 * role and hard-cleans afterwards. Nothing touches a real shop, and no shop
 * password needs to be known.
 *
 * Everything is scoped to RUN (a per-process id) so concurrent/repeat runs
 * can't delete each other's fixtures â€” a bare prefix delete is ONE statement
 * matching every run's rows, and one FK-blocked straggler poisons them all.
 *
 * Usage:
 *   import { owner, provisionShop, check, summary, cleanup } from "./_harness.mjs";
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);

export const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
export const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** Unique per process â€” every fixture name/note carries it. */
export const RUN = Date.now().toString(36).toUpperCase();

export const P = (c) => `â‚±${(c / 100).toLocaleString()}`;

export const admin = createClient(SB_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// â”€â”€ assertions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let pass = 0, fail = 0;

export function check(name, ok, detail = "") {
  console.log(`  ${ok ? "âœ“" : "âœ—"} ${name}${ok || !detail ? "" : ` â€” ${detail}`}`);
  ok ? pass++ : fail++;
  return !!ok;
}

export function section(title) {
  console.log(`\n${title}`);
}

/** Print the tally and exit non-zero on any failure. */
export function summary() {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// â”€â”€ clients â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export function anonClient() {
  return createClient(SB_URL, ANON, { auth: { persistSession: false } });
}

export async function signIn(email, password) {
  const c = anonClient();
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return c;
}

/** The owner login is the one account the user has NOT repurposed. */
export const owner = await signIn("robertmaestro09@gmail.com", "rajonrondo09");

// â”€â”€ fixtures (tracked so cleanup can find them) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const shops = [];
const parts = [];
const engines = [];
const models = [];
const suppliers = [];
const customers = [];
const expenseCategories = [];
const receiptPaths = [];

/**
 * A throwaway shop with its own employee login. Never a real branch.
 * Returns { id, name, client, email, userId }.
 */
export async function provisionShop(label = "Shop") {
  const name = `ZZ-TEST ${label} ${RUN}`;
  const { data: shop, error } = await admin
    .from("shops").insert({ name }).select().single();
  if (error) throw new Error(`provisionShop(${label}): ${error.message}`);

  const email = `zz-${RUN.toLowerCase()}-${shops.length}@test.local`;
  const password = `Zz!${RUN}9a`;
  const { data: u, error: uErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (uErr) throw new Error(`provisionShop user: ${uErr.message}`);

  const { error: pErr } = await admin.from("profiles").insert({
    id: u.user.id, full_name: `ZZ-TEST ${label} Staff`,
    role: "employee", shop_id: shop.id,
  });
  if (pErr) throw new Error(`provisionShop profile: ${pErr.message}`);

  const rec = { id: shop.id, name, client: await signIn(email, password), email, userId: u.user.id };
  shops.push(rec);
  return rec;
}

/**
 * Track a shop created directly (not via provisionShop) so cleanup sweeps it
 * and its children too. Same precedent as trackEngine: a script that needs to
 * PROVE `owner can create a shop` must insert one itself, and an untracked shop
 * would be left behind in a live database.
 */
export function trackShop(id, label = "Direct") {
  if (id) shops.push({ id, name: `ZZ-TEST ${label} ${RUN}`, client: null, email: null, userId: null });
  return id;
}

export async function firstCategoryId() {
  const { data } = await owner
    .from("product_categories").select("id").is("deleted_at", null).limit(1).single();
  return data.id;
}

/** A part in the master catalog. cost/price in centavos.
 *  Seeded via the SERVICE ROLE: 0049 revoked catalog INSERT from app roles
 *  (creation is fn_receive_stock's job) — fixtures aren't receivings. */
export async function seedPart({
  label = "Widget", cost = 1000, price = 2500, reorder_level = 0,
  sku = null, barcode = null, name = null,
} = {}) {
  const { data, error } = await admin.from("parts").insert({
    name: name ?? `ZZ-TEST ${label} ${RUN}`,
    category_id: await firstCategoryId(),
    cost_centavos: cost, price_centavos: price, reorder_level,
    sku, barcode,
  }).select().single();
  if (error) throw new Error(`seedPart: ${error.message}`);
  parts.push(data.id);
  return data;
}

export async function seedEngineModel({ brand = "ZZ-TEST", model = "M", hp = 15 } = {}) {
  const { data, error } = await admin.from("engine_models").insert({
    brand: `${brand}`, model: `${model}-${RUN}`, horsepower: hp,
    default_warranty_months: 12,
  }).select().single();
  if (error) throw new Error(`seedEngineModel: ${error.message}`);
  models.push(data.id);
  return data;
}

export async function seedSupplier({ label = "Supplier", ...rest } = {}) {
  const { data, error } = await owner.from("suppliers").insert({
    name: `ZZ-TEST ${label} ${RUN}`, ...rest,
  }).select().single();
  if (error) throw new Error(`seedSupplier: ${error.message}`);
  suppliers.push(data.id);
  return data;
}

export async function seedCustomer({ label = "Buyer" } = {}) {
  const { data, error } = await owner.from("customers").insert({
    name: `ZZ-TEST ${label} ${RUN}`,
  }).select().single();
  if (error) throw new Error(`seedCustomer: ${error.message}`);
  customers.push(data.id);
  return data;
}

/**
 * A throwaway expense category. Every expense a script books against it is
 * swept by cleanup â€” which is how COMPANY-scoped expenses (shop_id IS NULL,
 * so invisible to a shop_id sweep) get cleaned up at all.
 */
export async function seedExpenseCategory({ label = "Category", sort_order = 900 } = {}) {
  const { data, error } = await owner.from("expense_categories").insert({
    name: `ZZ-TEST ${label} ${RUN}`, sort_order,
  }).select().single();
  if (error) throw new Error(`seedExpenseCategory: ${error.message}`);
  expenseCategories.push(data.id);
  return data;
}

/** Track an object uploaded to the private `receipts` bucket. */
export function trackReceipt(path) {
  if (path) receiptPaths.push(path);
  return path;
}

/** Track an engine created via fn_receive_stock so cleanup can reach it. */
export function trackEngine(id) {
  if (id) engines.push(id);
  return id;
}

/** Track a part created inline by fn_receive_stock (0048) — no seed helper ran. */
export function trackPart(id) {
  if (id) parts.push(id);
  return id;
}

/** Same, for an engine model created inline by fn_receive_stock (0048). */
export function trackEngineModel(id) {
  if (id) models.push(id);
  return id;
}

/** Same, for a customer created inline by fn_record_sale (p_customer). */
export function trackCustomer(id) {
  if (id) customers.push(id);
  return id;
}

/**
 * Receive parts/engines into master. Engine ids are auto-tracked.
 * Payment args are optional; omitted means the RPC's default ('paid' â†’ no debt).
 */
export async function receive({
  supplier_id = null, parts: pl = [], engines: el = [], note,
  payment_status, amount_paid, due_date, override, override_reason,
} = {}) {
  const args = {
    p_supplier_id: supplier_id,
    p_note: note ?? `ZZ-TEST rcv ${RUN}`,
    p_parts: pl,
    p_engines: el,
  };
  if (payment_status !== undefined) args.p_payment_status = payment_status;
  if (amount_paid !== undefined) args.p_amount_paid = amount_paid;
  if (due_date !== undefined) args.p_due_date = due_date;
  if (override !== undefined) args.p_override = override;
  if (override_reason !== undefined) args.p_override_reason = override_reason;

  const { data, error } = await owner.rpc("fn_receive_stock", args);
  if (error) throw new Error(`receive: ${error.message}`);
  const { data: made } = await owner
    .from("receiving_lines").select("engine_id").eq("receiving_id", data);
  (made ?? []).forEach((r) => trackEngine(r.engine_id));
  return data;
}

/** Deliver to a shop AND have the shop confirm everything arrived. */
export async function deliverAndConfirm(shop, { parts: pl = [], engine_ids = [] }) {
  const { data: delId, error } = await owner.rpc("fn_deliver_stock", {
    p_shop_id: shop.id, p_note: `ZZ-TEST dlv ${RUN}`,
    p_parts: pl, p_engine_ids: engine_ids,
  });
  if (error) throw new Error(`deliver: ${error.message}`);

  const { data: lines } = await owner
    .from("delivery_lines").select("id, qty").eq("delivery_id", delId);
  const { error: cErr } = await shop.client.rpc("fn_confirm_delivery", {
    p_delivery_id: delId,
    p_lines: lines.map((l) => ({ line_id: l.id, qty_received: l.qty, shop_note: null })),
    p_note: null,
  });
  if (cErr) throw new Error(`confirm: ${cErr.message}`);
  return delId;
}

// â”€â”€ cleanup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/**
 * Hard-remove everything this RUN created, FK-safe (children first).
 *
 * Scoped to tracked ids only â€” never a bare `like 'X-TEST%'`, which would match
 * other runs' rows and fail as a whole if any one row is FK-blocked.
 *
 * stock_movements are deleted by BOTH shop_id AND part/engine id: the
 * master-side movement has shop_id IS NULL, so a shop-only delete strands it
 * and every later delete fails on the FK.
 */
export async function cleanup() {
  const shopIds = shops.map((s) => s.id);
  const del = (t) => admin.from(t).delete();
  const inShops = (t, col = "shop_id") =>
    shopIds.length ? del(t).in(col, shopIds) : Promise.resolve();

  // sales + everything hanging off them
  const { data: saleRows } = shopIds.length
    ? await admin.from("sales").select("id").in("shop_id", shopIds)
    : { data: [] };
  const saleIds = (saleRows ?? []).map((s) => s.id);
  if (saleIds.length) {
    await del("utang_payments").in("sale_id", saleIds);
    await del("warranty_claims").in(
      "warranty_id",
      ((await admin.from("warranties").select("id").in("sale_id", saleIds)).data ?? []).map((w) => w.id)
    );
    await del("warranties").in("sale_id", saleIds);
    await del("sale_line_costs").in("sale_id", saleIds);
    await del("sale_lines").in("sale_id", saleIds);
  }

  // movements must go before the things they point at
  await inShops("stock_movements");
  if (parts.length) await del("stock_movements").in("part_id", parts);
  if (engines.length) await del("stock_movements").in("engine_id", engines);

  await inShops("sales");

  // counts BEFORE losses â€” count_snapshot_lines.shortage_loss_id points at a loss
  const { data: snapRows } = shopIds.length
    ? await admin.from("count_snapshots").select("id").in("shop_id", shopIds)
    : { data: [] };
  const snapIds = (snapRows ?? []).map((s) => s.id);
  if (snapIds.length) await del("count_snapshot_lines").in("snapshot_id", snapIds);
  await inShops("count_snapshots");

  await inShops("losses");
  // expenses FK submission_batches (batch_id, 0051) AND deliveries — sweep
  // them BEFORE both. By category too: a company-scoped expense has
  // shop_id IS NULL, so the shop sweep alone would strand it.
  await inShops("expenses");
  if (expenseCategories.length) {
    await del("expenses").in("category_id", expenseCategories);
  }
  await inShops("submission_batches");

  // deliveries / returns / requests
  const { data: delRows } = shopIds.length
    ? await admin.from("deliveries").select("id").in("shop_id", shopIds)
    : { data: [] };
  const delIds = (delRows ?? []).map((d) => d.id);
  if (delIds.length) {
    await del("delivery_discrepancies").in("delivery_id", delIds);
    await del("delivery_lines").in("delivery_id", delIds);
  }
  await inShops("deliveries");

  const { data: retRows } = shopIds.length
    ? await admin.from("returns").select("id").in("shop_id", shopIds)
    : { data: [] };
  const retIds = (retRows ?? []).map((r) => r.id);
  if (retIds.length) await del("return_lines").in("return_id", retIds);
  await inShops("returns");

  const { data: reqRows } = shopIds.length
    ? await admin.from("delivery_requests").select("id").in("shop_id", shopIds)
    : { data: [] };
  const reqIds = (reqRows ?? []).map((r) => r.id);
  if (reqIds.length) await del("delivery_request_lines").in("delivery_request_id", reqIds);
  await inShops("delivery_requests");

  // payroll
  await inShops("payroll_entries");
  await inShops("staff_advances"); // FK on staff — must go before staff
  await inShops("staff");
  await del("pay_periods").like("label", `%${RUN}%`);
  await del("positions").like("title", `%${RUN}%`);

  // receivings + supplier debt
  const { data: rcvRows } = await admin
    .from("receivings").select("id").like("note", `%${RUN}%`);
  const rcvIds = (rcvRows ?? []).map((r) => r.id);
  if (rcvIds.length) {
    await del("supplier_payments").in("receiving_id", rcvIds);
    await del("receiving_lines").in("receiving_id", rcvIds);
  }
  if (parts.length) await del("receiving_lines").in("part_id", parts);
  if (engines.length) await del("receiving_lines").in("engine_id", engines);
  if (rcvIds.length) await del("receivings").in("id", rcvIds);
  if (suppliers.length) await del("supplier_payments").in("supplier_id", suppliers);

  // alerts + levels. Notifications by shop_id AND by ref_id: master-context
  // alerts (master_low_stock etc.) carry shop_id IS NULL, so inShops misses them.
  await inShops("notifications");
  if (parts.length) await del("notifications").in("ref_id", parts);
  if (engines.length) await del("notifications").in("ref_id", engines);
  if (parts.length) await del("shop_reorder_levels").in("part_id", parts);
  await inShops("shop_reorder_levels");
  if (parts.length) await del("stock_levels").in("part_id", parts);
  await inShops("stock_levels");

  // catalog. Engines are also swept by shop_id and by model: a script may
  // insert one directly rather than through receive(), and an untracked engine
  // holds an FK on the shop that blocks the delete below.
  if (engines.length) await del("engines").in("id", engines);
  await inShops("engines");
  if (models.length) await del("engines").in("engine_model_id", models);
  // part_merges (0052) FK both source and target parts — clear before parts
  if (parts.length) {
    await del("part_merges").in("source_part_id", parts);
    await del("part_merges").in("target_part_id", parts);
  }
  if (parts.length) await del("parts").in("id", parts);
  if (models.length) await del("engine_models").in("id", models);
  if (suppliers.length) await del("suppliers").in("id", suppliers);
  if (customers.length) await del("customers").in("id", customers);
  // fn_record_sale creates a customer INLINE from p_customer, so a script that
  // sells to a walk-in never gets an id to track. Every harness-made name
  // carries RUN, and RUN is unique per process â€” so this cannot reach another
  // run's rows, let alone a real customer.
  await del("customers").like("name", `%${RUN}%`);
  // after the expenses that reference them
  if (expenseCategories.length) await del("expense_categories").in("id", expenseCategories);
  // category proposals created inside fn_record_shop_expense reference the
  // shop (proposed_by_shop_id) and would FK-block the shop delete below
  await inShops("expense_categories", "proposed_by_shop_id");
  if (receiptPaths.length) await admin.storage.from("receipts").remove(receiptPaths);

  // logins + shops last
  for (const s of shops) {
    if (!s.userId) continue; // trackShop() shops have no login of their own
    await del("profiles").eq("id", s.userId);
    await admin.auth.admin.deleteUser(s.userId).catch(() => {});
  }
  // Profiles reassigned onto a temp shop by another script would FK-block the
  // shop delete below; they are this RUN's users, so they are already gone.
  if (shopIds.length) await del("shops").in("id", shopIds);

  // Check EVERY fixture class, not just shops: a part stranded by an FK is a
  // leak into a live database, and checking only shops would hide it.
  const leaks = [];
  const stillThere = async (table, ids, label) => {
    if (!ids.length) return;
    const { data } = await admin.from(table).select("id").in("id", ids);
    if (data?.length) leaks.push(`${data.length} ${label}`);
  };
  await stillThere("shops", shopIds, "shop(s)");
  await stillThere("parts", parts, "part(s)");
  await stillThere("engines", engines, "engine(s)");
  await stillThere("customers", customers, "customer(s)");
  {
    const { data } = await admin.from("customers").select("id").like("name", `%${RUN}%`);
    if (data?.length) leaks.push(`${data.length} inline customer(s)`);
  }
  await stillThere("suppliers", suppliers, "supplier(s)");
  await stillThere("engine_models", models, "engine model(s)");

  check(
    "cleanup: temp fixtures removed",
    leaks.length === 0,
    `left behind: ${leaks.join(", ")} â€” run scripts/sweep-test-fixtures.mjs`
  );
}
