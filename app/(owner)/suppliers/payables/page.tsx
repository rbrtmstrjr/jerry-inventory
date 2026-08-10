import { redirect } from "next/navigation";

/** Payables is a tab on /suppliers now. Old bookmarks and notification links
 *  land here. */
export default function PayablesMovedStub() {
  redirect("/suppliers?tab=payables");
}
