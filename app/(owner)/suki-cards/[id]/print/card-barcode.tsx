"use client";

import * as React from "react";
import JsBarcode from "jsbarcode";

/** Code128 of the card number — same library/format as the product labels,
    so the shops' existing scanners read it. */
export function CardBarcode({ value }: { value: string }) {
  const ref = React.useRef<SVGSVGElement>(null);

  React.useEffect(() => {
    if (ref.current) {
      try {
        JsBarcode(ref.current, value, {
          format: "CODE128",
          width: 1.6,
          height: 34,
          displayValue: false,
          margin: 0,
          background: "transparent",
        });
      } catch {
        // invalid chars — leave blank
      }
    }
  }, [value]);

  return <svg ref={ref} aria-label={`Card barcode ${value}`} />;
}
