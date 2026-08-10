/** Shop palette KEYS only — the colors are tokens in app/theme.css and no
 *  component sees a hex. Must match the shops.color_key CHECK. */
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

/** Resolve a key to its CSS custom properties; an unknown or null key gets the
 *  neutral fallback. */
export function shopColorVars(key: string | null | undefined): {
  soft: string;
  strong: string;
  solid: string;
} {
  if (!isShopColorKey(key)) {
    return {
      soft: "var(--secondary)",
      strong: "var(--muted-foreground)",
      // neutral fallback badge: a mid-dark grey that carries white text
      solid: "var(--muted-foreground)",
    };
  }
  return {
    soft: `var(--shop-${key})`,
    strong: `var(--shop-${key}-strong)`,
    solid: `var(--shop-${key}-solid)`,
  };
}
