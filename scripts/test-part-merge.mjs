/**
 * 0052 — Part merge (catalog identity only; the ledger stays sacrosanct).
 *
 * fn_merge_parts folds a duplicate part into a survivor so Price Comparison
 * groups them as one product bought from two suppliers. The hard rules:
 * owner-only, one-hop, and merge is refused unless the source is safe to
 * RETIRE (zero stock, nothing in transit, no open sale/loss) — so no
 * stock_movements row is ever written, edited, or deleted and the
 * reconciliation invariant holds. Pricing rolls up via merged_into.
 */
import {
  owner, admin, check, section, summary, cleanup,
  provisionShop, seedPart, seedSupplier, seedEngineModel, receive, RUN,
} from "./_harness.mjs";

const A = await provisionShop("Merge");
const supA = await seedSupplier({ label: "MergeA" });
const supB = await seedSupplier({ label: "MergeB" });
const model = await seedEngineModel({ brand: "ZZ-TEST", model: "MergeFit" });

const merge = (client, source, target, note) =>
  client.rpc("fn_merge_parts", { p_source_id: source, p_target_id: target, p_note: note ?? null });

// ── 1. owner-only ────────────────────────────────────────────────────────────
section("Owner-only");
{
  const src = await seedPart({ label: "OwnSrc" });
  const tgt = await seedPart({ label: "OwnTgt" });
  const { error } = await merge(A.client, src.id, tgt.id);
  check("an employee cannot merge parts", /owner/i.test(error?.message ?? ""), error?.message);
}

// ── 2. identity / one-hop guards ─────────────────────────────────────────────
section("Guards: self / non-live / already-merged");
{
  const p = await seedPart({ label: "Self" });
  const { error: self } = await merge(owner, p.id, p.id);
  check("cannot merge a part into itself", /itself/i.test(self?.message ?? ""), self?.message);

  const retired = await seedPart({ label: "Retired" });
  await admin.from("parts").update({ deleted_at: new Date().toISOString() }).eq("id", retired.id);
  const live = await seedPart({ label: "LiveTgt" });
  const { error: intoDead } = await merge(owner, live.id, retired.id);
  check("cannot merge into a retired part", /retired/i.test(intoDead?.message ?? ""), intoDead?.message);
  const { error: fromDead } = await merge(owner, retired.id, live.id);
  check("cannot merge a retired source", /already retired/i.test(fromDead?.message ?? ""), fromDead?.message);

  // build a real one-hop: merge s1→canon, then try to merge s2→s1 (now merged)
  const canon = await seedPart({ label: "Canon" });
  const s1 = await seedPart({ label: "Hop1" });
  await merge(owner, s1.id, canon.id);
  const s2 = await seedPart({ label: "Hop2" });
  const { error: twoHop } = await merge(owner, s2.id, s1.id);
  check("cannot merge into an already-merged part (one hop only)",
    /surviving part/i.test(twoHop?.message ?? ""), twoHop?.message);
}

// ── 3. preconditions block (each with a specific message) ────────────────────
section("Preconditions: stock / transit / open lines");
{
  // live stock
  const stocked = await seedPart({ label: "Stocked" });
  const tgt = await seedPart({ label: "StockTgt" });
  await admin.from("stock_levels").insert({ part_id: stocked.id, shop_id: A.id, qty: 5 });
  const { error: hasStock } = await merge(owner, stocked.id, tgt.id);
  check("refused while the source holds stock (names qty + location)",
    /on hand/i.test(hasStock?.message ?? "") && /5/.test(hasStock?.message ?? ""), hasStock?.message);

  // in transit
  const transiting = await seedPart({ label: "Transit" });
  const { data: del } = await admin.from("deliveries")
    .insert({ shop_id: A.id, status: "in_transit", created_by: A.userId, note: `ZZ-TEST merge-transit ${RUN}` })
    .select().single();
  await admin.from("delivery_lines").insert({ delivery_id: del.id, part_id: transiting.id, qty: 2 });
  const { error: inTransit } = await merge(owner, transiting.id, tgt.id);
  check("refused while the source has in-transit units", /in transit/i.test(inTransit?.message ?? ""), inTransit?.message);

  // open (pending) loss
  const claimed = await seedPart({ label: "Claimed" });
  await admin.from("losses").insert({
    shop_id: A.id, recorded_by: A.userId, part_id: claimed.id, qty: 1,
    reason: "nasira", status: "pending", note: `ZZ-TEST merge-loss ${RUN}`,
  });
  const { error: openLine } = await merge(owner, claimed.id, tgt.id);
  check("refused while the source is on a pending loss", /pending sale\/loss/i.test(openLine?.message ?? ""), openLine?.message);
}

// ── 4. the happy merge: identity rolls up, ledger untouched ──────────────────
section("Merge rolls identity up to the survivor");
let src, tgt;
{
  // survivor: received from supplier B (real last-paid + master stock)
  tgt = await seedPart({ label: "Survivor", sku: `MRG-${RUN}` });
  await receive({
    supplier_id: supB.id,
    parts: [{ part_id: tgt.id, qty: 4, unit_cost_centavos: 150000 }],
    note: `ZZ-TEST merge-tgt ${RUN}`,
  });
  // duplicate: same SKU, zero stock, a QUOTE from supplier A + a fitment
  src = await seedPart({ label: "Duplicate", sku: `MRG-${RUN}` });
  await owner.from("supplier_quotes").insert({
    supplier_id: supA.id, part_id: src.id, unit_cost_centavos: 130000,
    quoted_at: new Date().toISOString().slice(0, 10), note: `ZZ-TEST ${RUN}`,
  });
  await admin.from("part_fitments").insert({ part_id: src.id, engine_model_id: model.id });

  const { count: movesBefore } = await admin
    .from("stock_movements").select("id", { count: "exact", head: true }).eq("part_id", src.id);

  const { error } = await merge(owner, src.id, tgt.id, "same carburetor, two suppliers");
  check("merge succeeds", !error, error?.message);

  const { data: srcRow } = await admin
    .from("parts").select("merged_into, deleted_at").eq("id", src.id).single();
  check("source points at the survivor", srcRow?.merged_into === tgt.id);
  check("source is soft-deleted", !!srcRow?.deleted_at);

  const { data: srcLevels } = await admin
    .from("stock_levels").select("id").eq("part_id", src.id);
  check("source's (zero) stock_levels rows are dropped", (srcLevels ?? []).length === 0);

  const { count: movesAfter } = await admin
    .from("stock_movements").select("id", { count: "exact", head: true }).eq("part_id", src.id);
  check("NO stock_movements row created/edited/deleted by the merge", movesBefore === movesAfter);

  const { data: fit } = await owner
    .from("part_fitments").select("part_id").eq("part_id", tgt.id).eq("engine_model_id", model.id);
  check("fitment carried forward to the survivor", (fit ?? []).length === 1);

  const { data: audit } = await owner
    .from("part_merges").select("*").eq("source_part_id", src.id).single();
  check("merge is audited (source/target/by/note)",
    audit?.target_part_id === tgt.id && !!audit?.merged_by && !!audit?.note);
}

// ── 5. comparison now groups both suppliers under the survivor ───────────────
section("Comparison rollup");
{
  const { data: cmp } = await owner
    .from("supplier_price_comparison").select("supplier_id, effective_source, supplier_count, is_cheapest")
    .eq("part_id", tgt.id);
  check("survivor now shows BOTH suppliers", (cmp ?? []).length === 2, `got ${cmp?.length}`);
  check("supplier_count = 2 (comparable)", (cmp ?? []).every((r) => r.supplier_count === 2));
  const suppliers = new Set((cmp ?? []).map((r) => r.supplier_id));
  check("both supplier A (quote) and B (paid) are present",
    suppliers.has(supA.id) && suppliers.has(supB.id));
  check("the cheaper supplier is badged cheapest",
    (cmp ?? []).some((r) => r.is_cheapest && r.supplier_id === supA.id));
  // the merged source must NOT appear as its own product
  const { data: srcCmp } = await owner
    .from("supplier_price_comparison").select("part_id").eq("part_id", src.id);
  check("the retired duplicate no longer appears as a separate product", (srcCmp ?? []).length === 0);
}

// ── 6. reconciliation invariant still holds for the live survivor ────────────
section("Ledger invariant");
{
  const { data: moves } = await owner
    .from("movement_journal").select("qty_change, location_kind, shop_id").eq("part_id", tgt.id);
  const ledger = (moves ?? [])
    .filter((m) => m.location_kind !== "transit")
    .reduce((s, m) => s + m.qty_change, 0);
  const { data: levels } = await owner
    .from("stock_levels").select("qty").eq("part_id", tgt.id);
  const onHand = (levels ?? []).reduce((s, l) => s + l.qty, 0);
  check("Σ movements = stock_levels for the survivor (invariant intact)", ledger === onHand,
    `ledger ${ledger} vs on-hand ${onHand}`);
}

// supplier_quotes aren't tracked by the harness — sweep before cleanup
await owner.from("supplier_quotes").delete().in("supplier_id", [supA.id, supB.id]);
await cleanup();
summary();
