-- ---------------------------------------------------------------------------
-- 0050 — Shop colors: visual shop identity across the system
--
-- Shops get a color so the owner SCANS a list ("Sold · Ternate") instead of
-- reading every row. Rules the schema enforces:
--
--   • The column stores a PALETTE KEY ('teal', 'amber', …), never a hex.
--     Colors are design tokens defined once in app/theme.css (light + dark
--     pairs); a stored hex would smuggle raw color past the token system.
--     The CHECK below keeps an invalid key from being written via PostgREST.
--   • UNIQUE among live shops (partial index WHERE deleted_at IS NULL) — two
--     shops sharing a color defeats the feature. A closed shop releases its
--     color for reuse.
--   • Nullable: a shop with no color renders a neutral badge with its name
--     intact. Color is an accelerant, never the information.
--
-- Backfill: existing live shops get distinct colors deterministically by
-- creation order, so the feature is useful immediately.
-- ---------------------------------------------------------------------------

alter table public.shops add column if not exists color_key text;

alter table public.shops
  add constraint shops_color_key_valid check (
    color_key is null or color_key in (
      'slate','teal','amber','rose','violet',
      'emerald','sky','orange','indigo','lime'
    )
  );

create unique index if not exists shops_color_key_unique
  on public.shops (color_key)
  where deleted_at is null;

comment on column public.shops.color_key is
  'Palette KEY (never a hex) resolved to theme tokens at render. Unique among
   live shops; null = neutral badge. Keys listed in the CHECK must stay in
   sync with lib/shop-colors.ts and app/theme.css.';

-- Deterministic backfill: distinct colors by creation order (first 10 live
-- shops; any beyond that stay null/neutral until recolored by the owner).
with ranked as (
  select id, row_number() over (order by created_at, id) as rn
  from public.shops
  where deleted_at is null and color_key is null
)
update public.shops s
set color_key = (array[
  'teal','amber','violet','emerald','rose',
  'sky','orange','indigo','lime','slate'
])[r.rn]
from ranked r
where r.id = s.id and r.rn <= 10;
