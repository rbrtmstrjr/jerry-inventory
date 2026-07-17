import { redirect } from "next/navigation";

/**
 * Bulk Add retired (0048) — creating products with no supplier and no stock
 * contradicted "receiving is the single entry point". Bulk entry lives on as
 * the bulk-lines grid inside Receiving, which itself moved to Suppliers.
 * Points straight at the final home (no redirect chain). Kept so old
 * bookmarks don't 404, same pattern as the other redirect stubs.
 */
export default function BulkAddMovedStub() {
  redirect("/suppliers?tab=receiving");
}
