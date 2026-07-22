"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * One side per print job — the physical flow is: print the front, re-feed the
 * same sheet, print the back. A data attribute on <html> tells the route's
 * print CSS which face to keep; it clears itself after the dialog closes, so a
 * plain Ctrl+P still prints both pages.
 */
function printSide(side: "front" | "back") {
  const root = document.documentElement;
  root.setAttribute("data-print-side", side);
  window.addEventListener(
    "afterprint",
    () => root.removeAttribute("data-print-side"),
    { once: true }
  );
  window.print();
}

export function PrintSideButtons() {
  return (
    <div className="flex items-center gap-2">
      <Button onClick={() => printSide("front")}>
        <Printer className="size-4" /> Print front
      </Button>
      <Button variant="outline" onClick={() => printSide("back")}>
        <Printer className="size-4" /> Print back
      </Button>
    </div>
  );
}
