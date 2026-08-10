import { redirect } from "next/navigation";

/** Suppliers became its own section at the head of INVENTORY. This stub keeps
 *  old bookmarks alive. */
export default function SuppliersMovedStub() {
  redirect("/suppliers?tab=directory");
}
