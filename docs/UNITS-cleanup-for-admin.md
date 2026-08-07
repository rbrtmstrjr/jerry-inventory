# Units cleanup — for the office, before the fractional-quantity release

**Why:** we are about to let quantity accept half-kilos (`0.5`, `2.3`). Which
products may be split is decided by the product's **unit**, so the unit has to
mean one thing. Today it is a free-text box and 13 products carry a spelling the
system will not recognise. The release **stops** if any of them are left.

**What we need:** every product's unit set to one of the seven values below,
using that exact spelling. Nothing else about the product changes.

**Where:** Master Inventory → click a product → **Unit** field → Save.

---

## The only seven values allowed

| Type this | Means |
|---|---|
| `pc` | piece — the default for anything counted one at a time |
| `kg` | kilogram — **the only one that will allow half quantities** |
| `set` | set |
| `box` | box |
| `roll` | roll |
| `pair` | pair |
| `m` | metre |

Lower case, no spaces. `PC`, `Pcs`, `pieces` are all wrong.

> The box currently suggests "pc / liter / meter". Ignore that hint — `liter`
> and `meter` spelled out are **not** valid. That hint is what caused this mess
> and it goes away in the release.

---

## The 13 products to fix

Run this in the SQL editor and use **Export → CSV** to hand the list over:

```sql
select
  p.name                                   as product,
  coalesce(p.sku, '')                      as sku,
  p.unit                                   as current_unit,
  case
    when lower(btrim(p.unit)) in ('pcs','un','unit','1') then 'pc'
    when lower(btrim(p.unit)) = 'm'                      then 'm  (confirm: metre, not Medium)'
    when lower(btrim(p.unit)) = 'ft'                     then 'DECIDE — see note'
    else 'DECIDE'
  end                                      as suggested_unit,
  coalesce(sum(sl.qty), 0)                 as on_hand_total,
  case when p.deleted_at is null then 'active' else 'retired' end as status
from public.parts p
left join public.stock_levels sl on sl.part_id = p.id
where coalesce(p.unit,'') not in ('pc','kg','set','box','roll','pair','m')
group by p.id, p.name, p.sku, p.unit, p.deleted_at
order by p.unit, p.name;
```

Retired products are included **on purpose** — the database rule applies to them
too, so one discontinued item with a stray unit blocks the whole release.

---

## What each bad value almost certainly is

| Current | Count | Change to | Safe? |
|---|---|---|---|
| `pcs` | 2 | `pc` | ✅ spelling only |
| `un` | 1 | `pc` | ✅ spelling only |
| `unit` | 6 | `pc` | ✅ spelling only |
| `1` | 1 | `pc` | ✅ someone typed a quantity into the unit box |
| `M` | 2 | `m` **only if it means metre** | ⚠️ see below |
| `Ft` | 1 | **ask Gerry** | ⚠️ see below |

### ⚠️ `M` — check before changing

`M` might mean **metre**, or it might mean **Medium** (a size). If those two
products are sized goods, the unit is not a measurement at all and should be
`pc`. Look at the product name before deciding. Getting this wrong makes a
product sellable by the half-metre when it should not be.

### ⚠️ `Ft` — this one is NOT a spelling fix

Feet is not in the list, and **relabelling feet as metres changes what the stock
figure means**. A product showing `50` on hand is 50 feet; call it `m` and the
system now believes 50 metres — a 3× overstatement of what is on the shelf.

Three honest options, Gerry's call:

1. **Sell it in metres properly** — change the unit *and* convert the quantity
   (50 ft = 15.2 m). Needs a stock adjustment, not just an edit.
2. **Add `ft` as a real unit** — if the shop genuinely sells by the foot. One
   line for the developer, no data change, no risk.
3. **Make it `pc`** — if it is actually sold as a whole item (a 50-foot coil
   sold as one coil), not measured out.

---

## When the office says it is done

Run this. It must return **zero rows**:

```sql
select coalesce(unit,'(null)') as unit, count(*)
from public.parts
where coalesce(unit,'') not in ('pc','kg','set','box','roll','pair','m')
group by 1;
```

Zero rows = the release is unblocked. Anything else = that value still needs a
decision.

---

## Two notes for whoever does the editing

- **Only the Unit field changes.** Do not touch cost, selling price or reorder
  level while you are in there — price edits are owner-only and will be refused.
- **Nothing about stock changes.** Correcting a spelling does not move, add or
  remove a single item. The only exception is `Ft` if option 1 is chosen, which
  is a deliberate stock adjustment and should be done separately.

---

## After the release

The Unit box becomes a **dropdown** — the seven values above, nothing else
typeable. This cleanup is a one-time debt from the free-text field; it cannot
happen again afterwards.

Kilogram is the only one that allows half quantities today. Metre is the obvious
next candidate (rope, hose, chain) and is a one-line change whenever Gerry wants
it.
