import { redirect } from "next/navigation";

/** Delivery Requests live on Stock Alerts — a request is a stock-alert signal,
 *  not a movement. Kept as a redirect so old links don't 404. */
export default function DeliveryRequestsRedirect() {
  redirect("/stock-alerts?tab=requests");
}
