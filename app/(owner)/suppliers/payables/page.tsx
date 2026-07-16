import { redirect } from "next/navigation";

/**
 * Payables is now a tab on the consolidated /suppliers section, next to the
 * directory it charges against. Old bookmarks and notification links land here.
 */
export default function PayablesMovedStub() {
  redirect("/suppliers?tab=payables");
}
