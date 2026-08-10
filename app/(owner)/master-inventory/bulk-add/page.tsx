import { redirect } from "next/navigation";

/** Bulk Add retired (0048) — bulk entry lives in Receiving. Kept as a stub so
 *  old bookmarks don't 404; points at the final home, no redirect chain. */
export default function BulkAddMovedStub() {
  redirect("/suppliers?tab=receiving");
}
