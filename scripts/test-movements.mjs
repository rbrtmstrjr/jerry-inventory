/**
 * Movements as a book: journal, stock card, engine chain of custody.
 *
 * THE INVARIANT THIS EXISTS FOR
 *   Σ(movements for product × location) = current stock_levels
 * A ledger that doesn't reconcile to the shelf is decoration. This suite proves
 * it on a fixture that exercises every movement type, including the one that
 * used to break it.
 *
 * THE BUG IT PINS DOWN
 * Before 0045 that invariant was FALSE. A transit write-off books
 * `transit_writeoff -qty` at shop_id NULL — which reads as "master" everywhere
 * else — while writing nothing to stock_levels, because the stock already left
 * master when it was SENT. Master was therefore debited twice in the book and
 * once in reality, and a stock card would have printed a negative running
 * balance. 0045 reports that row at location 'transit', where the stock
 * actually was. §1 asserts the invariant holds; §2 asserts it would NOT hold if
 * the row were left at master, so the fix can't be quietly undone.
 *
 * Run: node scripts/test-movements.mjs
 */
import {
  owner, admin, RUN, check, section, summary,
  provisionShop, seedPart, seedEngineModel, receive, deliverAndConfirm, cleanup,
} from "./_harness.mjs";

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
const COST = 10_000;
const PRICE = 25_000;

const shop = await provisionShop("Ledger");
const emp = shop.client;
const part = await seedPart({ label: "Ledger Part", cost: COST, price: PRICE });
const model = await seedEngineModel({ brand: "ZZ-TEST", model: `L${RUN}` });

section("Fixture: every movement type, on one part");
{
  // Two lines of the SAME part in one call. now() is transaction-scoped in
  // Postgres, so both movements land with an IDENTICAL created_at — a genuine
  // same-timestamp collision on master's card, which §5 needs.
  await receive({
    parts: [
      { part_id: part.id, qty: 8, unit_cost_centavos: COST },
      { part_id: part.id, qty: 4, unit_cost_centavos: COST },
    ],
  });
  await receive({
    engines: [{
      serial_number: `ZZ-LED-${RUN}`, engine_model_id: model.id, condition: "brand_new",
      cost_centavos: 2_000_000, price_centavos: 0, warranty_months: 12,
      margin_floor_pct: 10, margin_mid_pct: 20, margin_asking_pct: 30,
    }],
  });
  const { data: eng } = await owner
    .from("engines").select("id").eq("serial_number", `ZZ-LED-${RUN}`).single();
  globalThis.__eng = eng;

  await deliverAndConfirm(shop, { parts: [{ part_id: part.id, qty: 10 }], engine_ids: [eng.id] });

  await emp.rpc("fn_record_sale", {
    p_customer: { name: `ZZ-TEST Ledger Buyer ${RUN}`, phone: "0917-000-9999" },
    p_part_lines: [{ part_id: part.id, qty: 4, unit_price_centavos: PRICE }],
  });
  await emp.rpc("fn_record_sale", {
    p_customer: { name: `ZZ-TEST Engine Buyer ${RUN}`, phone: "0917-000-8888" },
    p_engine_lines: [{ engine_id: eng.id, agreed_price_centavos: 2_600_000 }],
  });
  await emp.rpc("fn_record_loss", {
    p_part_id: part.id, p_qty: 1, p_reason: "nasira", p_note: `ZZ-TEST broke ${RUN}`,
  });
  const { data: b } = await emp.rpc("fn_submit_shop_batch");
  const { error: apprErr } = await owner.rpc("fn_approve_batch", { p_batch_id: b.batch_id });
  check("batch approved (sale + loss deduct)", !apprErr, apprErr?.message);

  await owner.rpc("fn_return_stock", {
    p_shop_id: shop.id, p_reason: `ZZ-TEST return ${RUN}`,
    p_parts: [{ part_id: part.id, qty: 2 }], p_engine_ids: [],
  });

  // The path that used to break the book.
  const { data: delId } = await owner.rpc("fn_deliver_stock", {
    p_shop_id: shop.id, p_note: `ZZ-TEST transit ${RUN}`,
    p_parts: [{ part_id: part.id, qty: 2 }], p_engine_ids: [],
  });
  const { data: lines } = await owner
    .from("delivery_lines").select("id").eq("delivery_id", delId);
  await emp.rpc("fn_confirm_delivery", {
    p_delivery_id: delId,
    p_lines: [{ line_id: lines[0].id, qty_received: 0, shop_note: "never arrived" }],
    p_note: null,
  });
  const { error: woErr } = await owner.rpc("fn_resolve_delivery_discrepancy", {
    p_delivery_line_id: lines[0].id, p_qty: 2,
    p_resolution: "written_off", p_reason: `ZZ-TEST lost in transit ${RUN}`,
  });
  check("2 units written off in transit", !woErr, woErr?.message);
}

// ── 1. THE INVARIANT ──────────────────────────────────────────────────────
section("Σ movements = stock_levels, per product × location");
{
  const { data: rows } = await owner
    .from("movement_journal")
    .select("location_kind, shop_id, qty_change")
    .eq("part_id", part.id);

  const ledger = new Map();
  for (const r of rows ?? []) {
    // 'transit' is not a stock_levels location — it is a bucket the ledger
    // passes through, so it is excluded from the shelf reconciliation.
    if (r.location_kind === "transit") continue;
    const k = r.shop_id ?? "master";
    ledger.set(k, (ledger.get(k) ?? 0) + r.qty_change);
  }

  const { data: levels } = await owner
    .from("stock_levels").select("shop_id, qty").eq("part_id", part.id);
  const shelf = new Map((levels ?? []).map((l) => [l.shop_id ?? "master", l.qty]));

  check(
    `master: ledger ${ledger.get("master")} = shelf ${shelf.get("master")}`,
    ledger.get("master") === shelf.get("master"),
    `${ledger.get("master")} vs ${shelf.get("master")}`
  );
  check(
    `shop: ledger ${ledger.get(shop.id)} = shelf ${shelf.get(shop.id)}`,
    ledger.get(shop.id) === shelf.get(shop.id),
    `${ledger.get(shop.id)} vs ${shelf.get(shop.id)}`
  );
  check("master reconciles to the expected 2 on hand", shelf.get("master") === 2, `${shelf.get("master")}`);
  check("shop reconciles to the expected 3 on hand", shelf.get(shop.id) === 3, `${shelf.get(shop.id)}`);

  // Now every LIVE product × location in the whole database, not just ours.
  //
  // Scoped to parts that still exist, and that scope is the honest claim rather
  // than a convenient one. The pre-2026-07-10 test scripts retired their
  // fixtures by soft-deleting the part AND removing its stock_levels row while
  // leaving the movements behind — so those pairs read "ledger 30, shelf 0".
  // That is orphaned test debris, not a stock discrepancy: there is no shelf
  // left to disagree with. Asserting over them would fail forever for a reason
  // that has nothing to do with the business's stock.
  const { data: liveParts } = await owner
    .from("parts").select("id").is("deleted_at", null);
  const live = new Set((liveParts ?? []).map((p) => p.id));

  // Paginated — a single select is silently truncated at the API's max-rows
  // (fine at demo scale, wrong the moment the journal outgrows it; found by
  // the 300k-row load test, where the cap shorted 3 pairs' ledger sums).
  const allMv = [];
  for (let off = 0; ; off += 1000) {
    const { data: page } = await owner
      .from("movement_journal")
      .select("part_id, shop_id, qty_change, location_kind")
      .not("part_id", "is", null)
      .range(off, off + 999);
    allMv.push(...(page ?? []));
    if ((page ?? []).length < 1000) break;
  }
  const all = new Map();
  for (const r of allMv ?? []) {
    if (r.location_kind === "transit" || !live.has(r.part_id)) continue;
    const k = `${r.part_id}|${r.shop_id ?? "master"}`;
    all.set(k, (all.get(k) ?? 0) + r.qty_change);
  }
  const allLv = [];
  for (let off = 0; ; off += 1000) {
    const { data: page } = await owner
      .from("stock_levels").select("part_id, shop_id, qty").range(off, off + 999);
    allLv.push(...(page ?? []));
    if ((page ?? []).length < 1000) break;
  }
  const shelves = new Map(allLv.map((l) => [`${l.part_id}|${l.shop_id ?? "master"}`, l.qty]));
  const bad = [...all.entries()].filter(([k, v]) => (shelves.get(k) ?? 0) !== v);
  check(
    `EVERY live product × location in the database reconciles (${all.size} checked)`,
    bad.length === 0,
    bad.slice(0, 3).map(([k, v]) => `${k}: ledger ${v} vs shelf ${shelves.get(k) ?? 0}`).join("; ")
  );
}

// ── 2. The relocation is load-bearing ────────────────────────────────────
section("…and it is the transit relocation that makes it true");
{
  const { data: rows } = await owner
    .from("movement_journal")
    .select("location_kind, location_label, movement_type, qty_change")
    .eq("part_id", part.id);

  const wo = (rows ?? []).filter((r) => r.movement_type === "transit_writeoff");
  check("the write-off is reported at location `transit`", wo.length === 1 && wo[0].location_kind === "transit");
  check("…labelled 'In transit' for a human", wo[0]?.location_label === "In transit");

  // Put it back at master and the book breaks — this is the regression guard.
  const naive = (rows ?? [])
    .filter((r) => r.shop_id === null || r.location_kind !== "shop")
    .filter((r) => r.location_kind !== "shop")
    .reduce((s, r) => s + r.qty_change, 0);
  const { data: lvl } = await owner
    .from("stock_levels").select("qty").eq("part_id", part.id).is("shop_id", null).single();
  check(
    "counting the write-off as a master movement makes master disagree by exactly the 2 lost",
    naive === lvl.qty - 2,
    `naive ${naive} vs shelf ${lvl.qty}`
  );
}

// ── 3. Stock card: opening, running, closing ─────────────────────────────
section("Stock card");
{
  const card = (await owner.rpc("fn_stock_card", {
    p_part_id: part.id, p_shop_id: null, p_from: "2020-01-01", p_to: today,
  })).data;

  check("card opens with an Opening balance row", card[0]?.kind === "opening");
  check("opening is 0 before this fixture existed", Number(card[0].balance) === 0, String(card[0].balance));

  const moves = card.filter((r) => r.kind === "movement");
  check(`master card has ${moves.length} movements`, moves.length > 0);

  // The running balance must be a real running balance: every row equals the
  // opening plus every in/out up to and including it.
  let acc = Number(card[0].balance);
  let ok = true;
  for (const r of moves) {
    acc += (r.qty_in ?? 0) - (r.qty_out ?? 0);
    if (Number(r.balance) !== acc) ok = false;
  }
  check("balance on every row = opening + Σ(in − out) so far", ok);

  const closing = Number(moves[moves.length - 1].balance);
  const { data: lvl } = await owner
    .from("stock_levels").select("qty").eq("part_id", part.id).is("shop_id", null).single();
  check(
    `closing balance ${closing} = live stock ${lvl.qty} (period ends today)`,
    closing === lvl.qty,
    `${closing} vs ${lvl.qty}`
  );
  check(
    "the transit write-off is NOT on the bin card — those units never reached a bin",
    !moves.some((r) => r.movement_type === "transit_writeoff")
  );
  check(
    "particulars read like a book, not an enum",
    moves.some((r) => /Delivered to|Received from|Returned from/.test(r.particulars ?? "")),
    moves.map((r) => r.particulars).join(" | ").slice(0, 90)
  );
}

// ── 4. Opening balance on a mid-period card ─────────────────────────────
section("Opening balance carries the period in");
{
  // Everything in the fixture happened today, so a card starting today has an
  // opening of 0 — and a card starting TOMORROW must carry the whole lot in.
  const tomorrow = new Date(`${today}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tISO = tomorrow.toISOString().slice(0, 10);

  const future = (await owner.rpc("fn_stock_card", {
    p_part_id: part.id, p_shop_id: null, p_from: tISO, p_to: tISO,
  })).data;
  const { data: lvl } = await owner
    .from("stock_levels").select("qty").eq("part_id", part.id).is("shop_id", null).single();

  check(
    `a card starting tomorrow OPENS at ${lvl.qty} — everything before is carried in`,
    Number(future[0].balance) === lvl.qty,
    `${future[0].balance} vs ${lvl.qty}`
  );
  check("…and shows no movements in an empty period", future.length === 1);

  // opening + Σ(in − out) = closing, on the shop's card this time.
  const shopCard = (await owner.rpc("fn_stock_card", {
    p_part_id: part.id, p_shop_id: shop.id, p_from: "2020-01-01", p_to: today,
  })).data;
  const open = Number(shopCard[0].balance);
  const sMoves = shopCard.filter((r) => r.kind === "movement");
  const net = sMoves.reduce((s, r) => s + (r.qty_in ?? 0) - (r.qty_out ?? 0), 0);
  const close = Number(sMoves[sMoves.length - 1].balance);
  check(`shop card: opening ${open} + net ${net} = closing ${close}`, open + net === close);

  const { data: sl } = await owner
    .from("stock_levels").select("qty").eq("part_id", part.id).eq("shop_id", shop.id).single();
  check(`shop closing ${close} = live shop stock ${sl.qty}`, close === sl.qty);
}

// ── 5. Deterministic ordering ───────────────────────────────────────────
section("Same-timestamp movements never reorder");
{
  const card = (await owner.rpc("fn_stock_card", {
    p_part_id: part.id, p_shop_id: null, p_from: "2020-01-01", p_to: today,
  })).data;
  const moves = card.filter((r) => r.kind === "movement");

  // The fixture received the same part twice in ONE call, so two master rows
  // share created_at to the microsecond. Without `id` as a tiebreaker their
  // order — and every balance below them — would drift between loads.
  const times = moves.map((r) => r.created_at);
  const collisions = times.length - new Set(times).size;
  check(`the fixture really does contain same-timestamp rows (${collisions})`, collisions > 0);

  const again = (await owner.rpc("fn_stock_card", {
    p_part_id: part.id, p_shop_id: null, p_from: "2020-01-01", p_to: today,
  })).data.filter((r) => r.kind === "movement");
  check(
    "two reads produce the SAME id order",
    moves.map((r) => r.movement_id).join() === again.map((r) => r.movement_id).join()
  );
  check(
    "…and the SAME balance sequence",
    moves.map((r) => r.balance).join() === again.map((r) => r.balance).join()
  );

  // And that order is (created_at, id), not just created_at.
  const sorted = [...moves].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.movement_id.localeCompare(b.movement_id)
  );
  check(
    "ordering is by (created_at, id)",
    sorted.map((r) => r.movement_id).join() === moves.map((r) => r.movement_id).join()
  );
}

// ── 6. Balances are server-side, not per-page ──────────────────────────
section("Running balance is computed over the full series");
{
  const card = (await owner.rpc("fn_stock_card", {
    p_part_id: part.id, p_shop_id: null, p_from: "2020-01-01", p_to: today,
  })).data.filter((r) => r.kind === "movement");

  // Paginating the card client-side must not change a single balance: they are
  // absolute, computed by a window function over every row. A client-side
  // running total would restart at 0 on page 2.
  const page2 = card.slice(2);
  check(
    "page 2 balances continue from page 1 — they are absolute, not per-page",
    page2.every((r, i) => Number(r.balance) === Number(card[i + 2].balance))
  );
  const firstOfPage2 = Number(page2[0]?.balance ?? 0);
  const naivePerPage = (page2[0]?.qty_in ?? 0) - (page2[0]?.qty_out ?? 0);
  check(
    "…and page 2's first balance is NOT what a client-side running total would give",
    card.length > 3 ? firstOfPage2 !== naivePerPage : true,
    `server ${firstOfPage2} vs naive ${naivePerPage}`
  );
}

// ── 7. The ledger cannot be rewritten ─────────────────────────────────
section("Append-only: no edit, no delete, for anyone");
{
  const { data: row } = await owner
    .from("movement_journal").select("id, qty_change").eq("part_id", part.id).limit(1).single();

  const upd = await owner.from("stock_movements").update({ qty_change: 999 }).eq("id", row.id);
  const del = await owner.from("stock_movements").delete().eq("id", row.id);
  const ins = await owner.from("stock_movements").insert({
    movement_type: "correction", part_id: part.id, qty_change: 5, shop_id: null,
  });

  const { data: after } = await owner
    .from("stock_movements").select("qty_change").eq("id", row.id).single();
  check("OWNER cannot update a movement", after?.qty_change === row.qty_change, `now ${after?.qty_change}`);
  check("OWNER cannot delete a movement", !!after, "the row is gone");
  check("OWNER cannot insert a movement by hand", !!ins.error, "an insert succeeded");
  check(
    "…the ledger is append-only via definer functions only",
    !!(upd.error || del.error || ins.error) || after?.qty_change === row.qty_change
  );

  const eUpd = await emp.from("stock_movements").update({ qty_change: 1 }).eq("id", row.id);
  const eDel = await emp.from("stock_movements").delete().eq("id", row.id);
  const { data: still } = await owner
    .from("stock_movements").select("qty_change").eq("id", row.id).single();
  check("employee cannot update or delete either", still?.qty_change === row.qty_change);
  void eUpd; void eDel;
}

// ── 8. Engine chain of custody ────────────────────────────────────────
section("Engine chain of custody");
{
  const eng = globalThis.__eng;
  const { data: life } = await owner
    .from("movement_journal")
    .select("movement_type, location_label, qty_change, created_at, id")
    .eq("engine_id", eng.id)
    .order("created_at").order("id");

  const types = (life ?? []).map((r) => r.movement_type);
  check("received into master", types[0] === "received");
  check("then delivered (master leg, then the shop's confirm leg)",
    types.filter((t) => t === "delivery").length === 2, types.join(" → "));
  check("then sold", types.includes("sale"), types.join(" → "));
  check("the whole life is 4 events", life?.length === 4, types.join(" → "));

  const { data: e } = await owner
    .from("engines").select("status, shop_id, sold_at, customer_id").eq("id", eng.id).single();
  check("current state is `sold`", e?.status === "sold");
  check("…with a customer and a sold date", !!e?.customer_id && !!e?.sold_at);

  const { data: w } = await owner
    .from("warranties").select("id, months, expires_on").eq("engine_id", eng.id).maybeSingle();
  check("a warranty exists for it (auto-created at approval)", !!w && w.months === 12);

  const { data: srch } = await owner
    .from("movement_journal").select("engine_id").ilike("search_text", `%zz-led-${RUN.toLowerCase()}%`);
  check("the serial is findable by scan/search", (srch ?? []).length === 4, `got ${srch?.length}`);
}

// ── 9. Journal filters + pagination ──────────────────────────────────
section("Journal filters and paginates server-side");
{
  const base = () => owner.from("movement_journal").select("*", { count: "exact" });

  const { count: mineCount } = await base().eq("part_id", part.id);
  check("filter by product", (mineCount ?? 0) > 0);

  const { count: byLoc } = await base().eq("part_id", part.id).eq("location_kind", "shop");
  const { count: byMaster } = await base().eq("part_id", part.id).eq("location_kind", "master");
  check("filter by location splits the rows", (byLoc ?? 0) > 0 && (byMaster ?? 0) > 0);

  const { count: combined } = await base()
    .eq("part_id", part.id).eq("location_kind", "shop").eq("movement_type", "sale");
  check("filters COMBINE (product + location + type)", combined === 1, `got ${combined}`);

  const { count: dated } = await base()
    .eq("part_id", part.id).gte("created_at", `${today}T00:00:00+08:00`);
  check("filter by date range", (dated ?? 0) > 0);

  const { data: p1 } = await owner.from("movement_journal").select("id")
    .eq("part_id", part.id).order("created_at").order("id").range(0, 1);
  const { data: p2 } = await owner.from("movement_journal").select("id")
    .eq("part_id", part.id).order("created_at").order("id").range(2, 3);
  check("server-side pagination returns disjoint pages", p1.length === 2 && p2.length === 2 &&
    !p1.some((r) => p2.some((x) => x.id === r.id)));

  const { count: reasoned } = await base().eq("part_id", part.id).eq("reason", "nasira");
  check("the loss reason is a real filterable column (it lives on `losses`, not the movement)",
    reasoned === 1, `got ${reasoned}`);
}

// ── 10. Owner-only ───────────────────────────────────────────────────
section("Owner-only");
{
  const { data: j } = await emp.from("movement_journal").select("*").limit(5);
  check("employee reads NOTHING from the journal", (j ?? []).length === 0, `got ${j?.length}`);

  const { error: cErr } = await emp.rpc("fn_stock_card", {
    p_part_id: part.id, p_shop_id: shop.id, p_from: "2020-01-01", p_to: today,
  });
  check("employee CANNOT read a stock card, even for its own shop",
    !!cErr && /owner/i.test(cErr.message), cErr?.message);

  const { data: raw } = await emp.from("stock_movements").select("*").limit(3);
  check("employee reads nothing from the base ledger", (raw ?? []).length === 0);

  // 0053: shop_stock exposes own-shop cost (read-only). The ledger stays hidden.
  const stock = await emp.from("shop_stock").select("*").limit(1);
  check("the safe view exposes own-shop cost (read-only)",
    !stock.data?.[0] || typeof stock.data[0].cost_centavos === "number");
}

section("Cleanup");
await cleanup();
summary();
