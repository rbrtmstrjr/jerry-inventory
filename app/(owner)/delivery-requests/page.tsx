import { redirect } from "next/navigation";

/**
 * Delivery Requests moved into the Deliveries page as a tab — converting a
 * request only ever pre-filled the delivery form there anyway. Kept as a
 * redirect so old bookmarks and notification links don't 404.
 */
export default function DeliveryRequestsRedirect() {
  redirect("/deliveries?tab=requests");
}
