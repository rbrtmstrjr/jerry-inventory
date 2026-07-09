import Image from "next/image";
import { Package } from "lucide-react";

import { cn } from "@/lib/utils";
import { productImageUrl } from "@/lib/product-image";

/**
 * Square product thumbnail with a token-styled placeholder for imageless
 * products. next/image handles lazy loading + serving a right-sized variant.
 */
export function ProductThumb({
  path,
  alt,
  size = 40,
  className,
}: {
  path: string | null | undefined;
  alt: string;
  size?: number;
  className?: string;
}) {
  const url = productImageUrl(path);

  if (!url) {
    return (
      <div
        aria-hidden
        className={cn(
          "flex shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground",
          className
        )}
        style={{ width: size, height: size }}
      >
        <Package style={{ width: size * 0.45, height: size * 0.45 }} />
      </div>
    );
  }

  return (
    <Image
      src={url}
      alt={alt}
      width={size}
      height={size}
      className={cn(
        "shrink-0 rounded-md border bg-muted object-cover",
        className
      )}
      style={{ width: size, height: size }}
    />
  );
}

/** Full-width square image for card grids (placeholder when imageless). */
export function ProductCardImage({
  path,
  alt,
  className,
}: {
  path: string | null | undefined;
  alt: string;
  className?: string;
}) {
  const url = productImageUrl(path);

  return (
    <div
      className={cn(
        "relative flex aspect-square w-full items-center justify-center overflow-hidden bg-muted",
        className
      )}
    >
      {url ? (
        <Image
          src={url}
          alt={alt}
          width={400}
          height={400}
          className="size-full object-cover"
        />
      ) : (
        <Package aria-hidden className="size-1/3 text-muted-foreground/60" />
      )}
    </div>
  );
}
