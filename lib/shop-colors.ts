/**
 * Shop identity palette — the KEYS only. The actual colors are design tokens
 * in app/theme.css (--shop-<key> / --shop-<key>-strong, light + dark pairs);
 * components never see a hex. Must stay in sync with the shops.color_key
 * CHECK constraint (0050).
 */
export const SHOP_COLOR_KEYS = [
  "slate",
  "teal",
  "amber",
  "rose",
  "violet",
  "emerald",
  "sky",
  "orange",
  "indigo",
  "lime",
] as const;

export type ShopColorKey = (typeof SHOP_COLOR_KEYS)[number];

export function isShopColorKey(v: string | null | undefined): v is ShopColorKey {
  return !!v && (SHOP_COLOR_KEYS as readonly string[]).includes(v);
}

/**
 * Resolve a key to its CSS custom properties. An unknown/null key gets the
 * neutral fallback — nothing breaks without a color.
 */
export function shopColorVars(key: string | null | undefined): {
  soft: string;
  strong: string;
} {
  if (!isShopColorKey(key)) {
    return { soft: "var(--secondary)", strong: "var(--muted-foreground)" };
  }
  return { soft: `var(--shop-${key})`, strong: `var(--shop-${key}-strong)` };
}
