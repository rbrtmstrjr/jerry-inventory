import { redirect } from "next/navigation";

/**
 * Delivery Requests live on Stock Alerts (a request is a stock-alert signal,
 * not a movement). Kept as a redirect so old bookmarks / notification links
 * don't 404. (Previously pointed at /deliveries?tab=requests.)
 */
export default function DeliveryRequestsRedirect() {
  redirect("/stock-alerts?tab=requests");
}
