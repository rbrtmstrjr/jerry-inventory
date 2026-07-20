/**
 * 0051 — Shop-recorded expenses with approval.
 *
 * An expense is a claim that cash left — no stock footprint — so it is the
 * one shop-recorded thing that gets the PREVENTIVE control: it only counts
 * once approved. This suite proves the hard rules at the database:
 * the RPC forces own-shop + shop scope, recorded/pending/rejected never
 * count, categories are proposed-then-activated (or remapped), receipts are
 * path-isolated per shop, and company expenses are invisible to shops.
 */
import {
  owner, admin, check, section, summary, cleanup,
  provisionShop, seedExpenseCategory, RUN,
} from "./_harness.mjs";

const A = await provisionShop("ExpA");
const B = await provisionShop("ExpB");
const cat = await seedExpenseCategory({ label: "Fuel" });

const approvedTotal = async (shopId) => {
  const { data } = await owner
    .from("expenses").select("amount")
    .eq("shop_id", shopId).eq("status", "approved").is("deleted_at", null);
  return (data ?? []).reduce((s, e) => s + e.amount, 0);
};

// ── 1. the RPC forces own-shop + shop scope — there is nothing to spoof ─────
section("fn_record_shop_expense");
let expenseId;
{
  const { data, error } = await A.client.rpc("fn_record_shop_expense", {
    p_amount_centavos: 15000,
    p_description: `ZZ-TEST gas run ${RUN}`,
    p_category_id: cat.id,
  });
  expenseId = data;
  check("shop can record an expense", !error, error?.message);

  const { data: row } = await owner.from("expenses").select("*").eq("id", expenseId).single();
  check("scope forced to 'shop'", row?.scope === "shop");
  check("shop_id forced to the CALLER's shop", row?.shop_id === A.id);
  check("status = recorded, source = shop", row?.status === "recorded" && row?.source === "shop");
  check("recorded_by stamped", row?.recorded_by === A.userId);

  const { error: ownerErr } = await owner.rpc("fn_record_shop_expense", {
    p_amount_centavos: 100, p_description: "x", p_category_id: cat.id,
  });
  check("owner cannot use the shop RPC", /shop employees/.test(ownerErr?.message ?? ""));

  const { error: both } = await A.client.rpc("fn_record_shop_expense", {
    p_amount_centavos: 100, p_description: "x",
    p_category_id: cat.id, p_proposed_category: "Zzz",
  });
  check("category XOR proposal enforced", /exactly one/.test(both?.message ?? ""));

  const { error: badPath } = await A.client.rpc("fn_record_shop_expense", {
    p_amount_centavos: 100, p_description: "x", p_category_id: cat.id,
    p_receipt_path: `shop-${B.id}/steal.webp`,
  });
  check("receipt path outside own shop folder rejected", /own folder|shop''s folder|shop's folder/i.test(badPath?.message ?? ""), badPath?.message);
}

// ── 2. a recorded expense counts NOWHERE ────────────────────────────────────
section("Only approval counts");
{
  check("recorded expense has no approved-total effect", (await approvedTotal(A.id)) === 0);

  const { data: sub, error } = await A.client.rpc("fn_submit_shop_batch");
  check("an expense alone is submittable (4th batch type)", !error && sub?.expenses === 1, error?.message);

  const { data: row } = await owner.from("expenses").select("status, batch_id").eq("id", expenseId).single();
  check("submit flips recorded → pending with a batch", row?.status === "pending" && !!row?.batch_id);
  check("pending still has no approved-total effect", (await approvedTotal(A.id)) === 0);

  const { error: qErr } = await owner.rpc("fn_review_submission", {
    p_kind: "expense", p_id: expenseId, p_action: "question", p_note: "Saan ito?",
  });
  const { data: q } = await owner.from("expenses").select("status, review_note").eq("id", expenseId).single();
  check("question → questioned + note", !qErr && q?.status === "questioned" && q?.review_note === "Saan ito?", qErr?.message);

  const { error: aErr } = await owner.rpc("fn_approve_expense", { p_expense_id: expenseId });
  const { data: ap } = await owner.from("expenses").select("status, approved_by, approved_at").eq("id", expenseId).single();
  check("approve → approved + approver stamped", !aErr && ap?.status === "approved" && !!ap?.approved_by && !!ap?.approved_at, aErr?.message);
  check("NOW it counts", (await approvedTotal(A.id)) === 15000);

  const { error: again } = await owner.rpc("fn_approve_expense", { p_expense_id: expenseId });
  check("double-approve rejected", /already reviewed/.test(again?.message ?? ""));
}

// ── 3. category proposals: created on record, ACTIVATED only on approval ────
section("Category proposals");
{
  const propName = `ZZ-TEST Gasolina ${RUN}`;
  const { data: e1 } = await A.client.rpc("fn_record_shop_expense", {
    p_amount_centavos: 5000, p_description: `ZZ-TEST prop1 ${RUN}`,
    p_proposed_category: propName,
  });
  const { data: prop } = await owner
    .from("expense_categories").select("id, status, proposed_by_shop_id").eq("name", propName).single();
  check("proposal row created as status=proposed", prop?.status === "proposed");
  check("proposal credited to the shop", prop?.proposed_by_shop_id === A.id);

  const { data: e2 } = await A.client.rpc("fn_record_shop_expense", {
    p_amount_centavos: 6000, p_description: `ZZ-TEST prop2 ${RUN}`,
    p_proposed_category: propName.toUpperCase(),
  });
  const { data: dupCheck } = await owner
    .from("expense_categories").select("id").ilike("name", propName);
  check("same proposal (case-insensitive) reused, not duplicated", dupCheck?.length === 1);

  await A.client.rpc("fn_submit_shop_batch");

  // remap e1 to the existing active category — the proposal must NOT activate
  const { error: rErr } = await owner.rpc("fn_approve_expense", {
    p_expense_id: e1, p_remap_category_id: cat.id,
  });
  const { data: e1row } = await owner.from("expenses").select("category_id, status").eq("id", e1).single();
  const { data: propAfter } = await owner
    .from("expense_categories").select("status").eq("id", prop.id).single();
  check("remap approves onto the existing category", !rErr && e1row?.status === "approved" && e1row?.category_id === cat.id, rErr?.message);
  check("remap does NOT activate the proposal", propAfter?.status === "proposed");

  // approve e2 as-proposed — the proposal becomes a real category
  const { error: pErr } = await owner.rpc("fn_approve_expense", { p_expense_id: e2 });
  const { data: propFinal } = await owner
    .from("expense_categories").select("status").eq("id", prop.id).single();
  check("approve-as-proposed activates the category", !pErr && propFinal?.status === "active", pErr?.message);
}

// ── 4. reject never counts; batch approve carries expenses ──────────────────
section("Reject + batch");
{
  const before = await approvedTotal(A.id);
  const { data: rej } = await A.client.rpc("fn_record_shop_expense", {
    p_amount_centavos: 99900, p_description: `ZZ-TEST fake ${RUN}`, p_category_id: cat.id,
  });
  await A.client.rpc("fn_submit_shop_batch");
  await owner.rpc("fn_review_submission", {
    p_kind: "expense", p_id: rej, p_action: "reject", p_note: "Walang resibo",
  });
  const { data: r } = await owner.from("expenses").select("status").eq("id", rej).single();
  check("rejected stays rejected", r?.status === "rejected");
  check("rejected never counts", (await approvedTotal(A.id)) === before);

  const { data: bat } = await A.client.rpc("fn_record_shop_expense", {
    p_amount_centavos: 2500, p_description: `ZZ-TEST batch ${RUN}`, p_category_id: cat.id,
  });
  const { data: sub } = await A.client.rpc("fn_submit_shop_batch");
  const { data: res, error: bErr } = await owner.rpc("fn_approve_batch", {
    p_batch_id: sub.batch_id,
  });
  const { data: batRow } = await owner.from("expenses").select("status").eq("id", bat).single();
  check("fn_approve_batch approves pending expenses", !bErr && res?.expenses === 1 && batRow?.status === "approved", bErr?.message);
}

// ── 5. visibility: own shop yes (both sources), company & other shops never ─
section("RLS visibility");
{
  // owner records a shop-scoped expense for A and a company-wide one
  await owner.from("expenses").insert({
    category_id: cat.id, amount: 7000, scope: "shop", shop_id: A.id,
    description: `ZZ-TEST admin-for-A ${RUN}`,
  });
  await owner.from("expenses").insert({
    category_id: cat.id, amount: 8000, scope: "company", shop_id: null,
    description: `ZZ-TEST company ${RUN}`,
  });

  const { data: mine } = await A.client.from("expenses").select("description, source, scope");
  check("shop sees its own submissions", (mine ?? []).some((e) => e.source === "shop"));
  check(
    "shop sees Admin-recorded expenses FOR ITS shop",
    (mine ?? []).some((e) => e.description.includes("admin-for-A"))
  );
  check("company expenses invisible to the shop", !(mine ?? []).some((e) => e.scope === "company"));

  const { data: bSees } = await B.client.from("expenses").select("id").eq("shop_id", A.id);
  check("another shop sees NONE of A's expenses", (bSees ?? []).length === 0);

  const { data: owNew } = await owner
    .from("expenses").select("status, source").like("description", `%admin-for-A ${RUN}%`).single();
  check(
    "owner-recorded expense is born approved/owner (no approval step)",
    owNew?.status === "approved" && owNew?.source === "owner"
  );
}

// ── 6. receipts bucket: per-shop path isolation ─────────────────────────────
section("Receipts storage");
{
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const ownPath = `shop-${A.id}/zz-test-${RUN}.webp`;
  const { error: upOwn } = await A.client.storage.from("receipts").upload(ownPath, png, {
    contentType: "image/webp",
  });
  check("shop can upload into its own folder", !upOwn, upOwn?.message);

  const { error: upOther } = await A.client.storage.from("receipts")
    .upload(`shop-${B.id}/zz-steal-${RUN}.webp`, png, { contentType: "image/webp" });
  check("upload into ANOTHER shop's folder rejected", !!upOther);

  const { data: dlOwn, error: dlErr } = await A.client.storage.from("receipts").download(ownPath);
  check("shop can read its own receipt", !dlErr && !!dlOwn, dlErr?.message);

  const { data: bList } = await B.client.storage.from("receipts").list(`shop-${A.id}`);
  check("another shop cannot list A's receipts", (bList ?? []).length === 0);

  const { data: adminDl, error: adminErr } = await admin.storage.from("receipts").download(ownPath);
  check("service role (and owner policies) read all", !adminErr && !!adminDl, adminErr?.message);

  await admin.storage.from("receipts").remove([ownPath]);
}

// ── 7. reviewed history carries expenses (shop-sourced only) ────────────────
section("Reviewed history");
{
  const { data: hist } = await owner
    .from("reviewed_items").select("item_type, status, summary")
    .eq("item_type", "expense").in("shop_id", [A.id, B.id]);
  check("reviewed expenses appear in reviewed_items", (hist ?? []).length >= 3);
  check(
    "owner-recorded (never reviewed) expenses are NOT in the history",
    !(hist ?? []).some((h) => h.summary.includes("admin-for-A"))
  );
  const { data: empHist } = await A.client.from("reviewed_items").select("id").limit(3);
  check("employee sees zero reviewed history", (empHist ?? []).length === 0);
}

await cleanup(); // harness sweeps RPC-created proposals via proposed_by_shop_id
summary();
