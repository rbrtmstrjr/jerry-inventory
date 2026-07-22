import { cn } from "@/lib/utils";
import { shopColorVars } from "@/lib/shop-colors";

export interface ShopBadgeShop {
  name: string;
  color_key?: string | null;
}

/**
 * THE way a shop is named on screen. Color is an accelerant, never the
 * information: the name is always rendered (the `dot` variant is the one
 * exception and must sit next to adjacent text — never standalone), a shop
 * with no color falls back to neutral with its name intact, and print
 * documents skip this component entirely (text stays text).
 *
 * Colors resolve from theme tokens via the shop's palette key — no hex here.
 */
export function ShopBadge({
  shop,
  variant = "badge",
  className,
}: {
  shop: ShopBadgeShop;
  variant?: "badge" | "dot" | "text";
  className?: string;
}) {
  const { solid } = shopColorVars(shop.color_key);

  if (variant === "dot") {
    return (
      <span
        aria-hidden
        className={cn("inline-block size-2 shrink-0 rounded-full", className)}
        style={{ backgroundColor: solid }}
      />
    );
  }

  if (variant === "text") {
    return (
      <span className={cn("inline-flex items-center gap-1.5", className)}>
        <span
          aria-hidden
          className="inline-block size-2 shrink-0 rounded-full"
          style={{ backgroundColor: solid }}
        />
        <span className="truncate">{shop.name}</span>
      </span>
    );
  }

  // Solid fill + white text — reads as a category tag, never a status/alert.
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 truncate rounded-md px-2 py-0.5 text-xs font-medium text-white",
        className
      )}
      style={{ backgroundColor: solid }}
    >
      {shop.name}
    </span>
  );
}
