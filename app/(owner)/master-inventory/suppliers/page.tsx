import { redirect } from "next/navigation";

/**
 * Suppliers moved to /suppliers?tab=directory — stock starts at a supplier, so
 * Suppliers became a first-class section at the head of INVENTORY rather than
 * a tab inside Master Inventory. This stub keeps old bookmarks alive, same as
 * /delivery-requests.
 */
export default function SuppliersMovedStub() {
  redirect("/suppliers?tab=directory");
}
