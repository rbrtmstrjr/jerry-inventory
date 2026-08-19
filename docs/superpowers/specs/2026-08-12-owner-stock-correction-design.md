# Owner stock correction (master, parts) — design

Status: approved, not yet implemented
Migration: 0132
Branch: `feat/owner-stock-correction`

## Problem

An admin mis-encodes a quantity at receiving and master stock is wrong. Today
the only remedy is the developer hand-running SQL against production — done once
on 2026-08-12 for six products (124 units, PHP 44,310 at cost). Gerry wants to
correct the number himself.

The system models only ONE kind of discrepancy. `fn_record_count_shortages`
posts a difference as a `loss`, which lands in the P&L as shrinkage. That is
correct for stock that went missing and wrong for a number that was never true —
posting the 2026-08-12 correction as a loss would have invented PHP 44,310 of
shrinkage. There is no path for "this figure was mistyped".

Monthly Count cannot reach it either: `count_snapshots.shop_id` is NOT NULL, so
counts are shop-only and master has no reconciliation path at all.

## Decisions

| Question | Decision |
|---|---|
| Which stock | **Master only** (`stock_levels.shop_id IS NULL`) |
| Which products | **Parts only** — engines are one row per unit, no qty to edit |
| P&L meaning | **Correction only.** Never books shrinkage |
| Direction | **Both.** Set the actual number; it may be higher or lower |
| Who | **Gerry alone** (`is_primary_owner()`) — the admin who makes the errors must not be able to erase them |

## Non-goals

Out of scope, deliberately: shop stock, engines, any loss or shrinkage path,
`losses.shop_id`, Monthly Count, and the existing Edit Product dialog. The
system is in production; this change touches one new RPC and one new dialog.

## Design

### The control: `fn_correct_master_stock`

One `SECURITY DEFINER` RPC is the only way in. `stock_movements` keeps its
append-only property — no write policy is added for anyone.

```sql
create or replace function public.fn_correct_master_stock(
  p_part_id uuid,
  p_new_qty numeric,
  p_reason  text
) returns numeric                       -- the delta applied
language plpgsql security definer set search_path = public
as $$
declare v_old numeric; v_delta numeric; v_name text;
begin
  if not public.is_primary_owner() then
    raise exception 'Only the owner can correct stock';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Give a reason for the correction';
  end if;

  select name into v_name from parts
   where id = p_part_id and deleted_at is null and merged_into is null;
  if not found then raise exception 'Product not found'; end if;

  -- tenths + the unit rule, from the single authority that already owns it
  perform public.fn_assert_qty(p_part_id, p_new_qty, true);   -- allow zero

  select qty into v_old from stock_levels
   where part_id = p_part_id and shop_id is null for update;  -- lock vs delivery
  if not found then
    insert into stock_levels (part_id, shop_id, qty) values (p_part_id, null, 0);
    v_old := 0;
  end if;

  v_delta := p_new_qty - v_old;
  if v_delta = 0 then
    raise exception '% is already %', v_name, public.fmt_qty(p_new_qty);
  end if;

  -- contra-entry FIRST, so the ledger always explains the shelf
  insert into stock_movements (movement_type, part_id, qty_change, shop_id, actor, note)
  values ('correction', p_part_id, v_delta, null, auth.uid(),
          'Stock correction: ' || public.fmt_qty(v_old) || ' -> '
          || public.fmt_qty(p_new_qty) || ' (' || trim(p_reason) || ')');

  update stock_levels set qty = p_new_qty, updated_at = now()
   where part_id = p_part_id and shop_id is null;

  return v_delta;
end $$;

revoke all on function public.fn_correct_master_stock(uuid, numeric, text)
  from public, anon;
grant execute on function public.fn_correct_master_stock(uuid, numeric, text)
  to authenticated;
```

Why each piece:

- **`is_primary_owner()`** — matches the four existing Gerry-only locks (0100
  price, 0101 utang void, 0102 catalog retire, 0105 expense void) and satisfies
  `test-definer-guards`, which fails the build on an unguarded definer function.
- **`fn_assert_qty`** — the rule about which products may hold a fraction lives
  in one place and must not be re-implemented here.
- **`FOR UPDATE`** — `fn_deliver_stock` decrements the same row. Without the
  lock, a correction and a delivery interleaving lose one of the two writes.
- **movement before update** — the same order used in the 2026-08-12 manual fix.
  Both are inside the function, so it is atomic regardless.
- **`delta = 0` refused** — a no-op correction would otherwise write a ledger row
  saying nothing happened.

### Reporting: no changes needed

Verified against the current code:

- `lib/pnl.ts` filters movements only on `transit_writeoff`, so `correction` is
  invisible to revenue, COGS and shrinkage. **No fake shrinkage.**
- `movement_journal` maps `shop_id is null -> 'master'`, so corrections render
  under Master with no view change.
- `fn_stock_card` excludes only `transit_writeoff`, so corrections appear in the
  bin card and the running balance stays true.

### App layer

- `app/(owner)/master-inventory/actions.ts` — `correctMasterStock(input)`.
  Zod: `part_id` uuid, `new_qty` `qtySchema({ allowZero: true })`, `reason`
  1..300 chars. Re-checks `isPrimaryOwner()` for a readable message rather than
  a raw RLS error. Calls the RPC, then `revalidatePath`.
- `app/(owner)/master-inventory/correct-stock-dialog.tsx` — shows the system
  quantity, an input for the actual quantity, a required reason, and a live
  delta preview (`107 pc -> 12 pc  ·  -95 pc`). Uses `sanitizeQtyInput` and
  `parseQty`, never `parseInt`.
- `parts-table.tsx` — new `correctLocked` prop threaded exactly like
  `priceLocked` / `retireLocked`; the menu item is HIDDEN when locked, matching
  how the other destructive controls behave for an admin.
- `page.tsx` — `correctLocked={profile?.role === "admin"}`.

## Testing

`scripts/test-stock-correction.mjs`, exiting 2 until 0132 is applied:

- admin refused; employee refused; anon refused
- owner corrects DOWN and UP
- `delta = 0` refused; negative refused; `0.12` refused
- a `pc` product refuses `2.5`; a `kg` product accepts it
- empty reason refused
- **shop stock provably untouched**
- **ledger invariant holds**: `sum(qty_change) where shop_id is null` equals
  `stock_levels.qty` for that part
- **no `losses` row created** — shrinkage stays zero

`scripts/qa-browser/cs1-correct-stock.mjs`: Gerry sees the action and completes
a correction; the on-screen number matches the database afterwards; an admin
session cannot see the control at all.

## Rollout

1. branch off `staging` (done: `feat/owner-stock-correction`)
2. apply 0132 to staging
3. `npm test` + the QA script
4. manual QA by the user
5. push to production

## Risks

- **A correction can hide real shrinkage.** If stock actually walked and Gerry
  records it as a correction, the P&L never sees it. Mitigated by the mandatory
  reason and journal visibility, not prevented. Recording genuine master
  shrinkage needs `losses.shop_id` to become nullable — a separate change.
- **Upward corrections create stock from nothing.** Legitimate when a receiving
  was under-encoded, and the reason plus the ledger row make it auditable.
