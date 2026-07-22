import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import {
  ExpensesView,
  type CategoryOption,
  type DeliveryOption,
  type ExpenseRow,
} from "./expenses-view";

export const metadata: Metadata = { title: "Expenses" };

export default async function ExpensesPage() {
  const supabase = await createClient();

  const [expensesRes, categoriesRes, shopsRes, deliveriesRes] = await Promise.all([
    supabase
      .from("expenses")
      .select(
        `id, amount, expense_date, scope, shop_id, delivery_id, description,
         paid_to, payment_method, reference_no, receipt_image_path, category_id,
         status, source, review_note, batch_id,
         expense_categories(name), shops(name, color_key)`
      )
      .is("deleted_at", null)
      .order("expense_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("expense_categories")
      .select("id, name, sort_order")
      .eq("active", true)
      .eq("status", "active")
      .is("deleted_at", null)
      .order("sort_order"),
    supabase.from("shops").select("id, name").is("deleted_at", null).order("name"),
    supabase
      .from("deliveries")
      .select("id, delivered_at, note, shop_id, shops!deliveries_shop_id_fkey(name)")
      .is("deleted_at", null)
      .order("delivered_at", { ascending: false })
      .limit(50),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const expenses: ExpenseRow[] = (expensesRes.data ?? []).map((e: any) => ({
    id: e.id,
    amount: e.amount,
    expense_date: e.expense_date,
    scope: e.scope,
    shop_id: e.shop_id,
    shop_name: e.shops?.name ?? null,
    shop_color_key: e.shops?.color_key ?? null,
    delivery_id: e.delivery_id,
    description: e.description,
    paid_to: e.paid_to,
    payment_method: e.payment_method,
    reference_no: e.reference_no,
    receipt_image_path: e.receipt_image_path,
    category_id: e.category_id,
    category_name: e.expense_categories?.name ?? "?",
    status: e.status,
    source: e.source,
    review_note: e.review_note,
    batch_id: e.batch_id,
  }));

  const deliveries: DeliveryOption[] = (deliveriesRes.data ?? []).map((d: any) => ({
    id: d.id,
    shop_id: d.shop_id,
    label: `${new Date(d.delivered_at).toLocaleDateString("en-PH", {
      month: "short",
      day: "numeric",
    })} — ${d.shops?.name ?? "?"}${d.note ? ` (${d.note})` : ""}`,
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <ExpensesView
      expenses={expenses}
      categories={(categoriesRes.data ?? []) as CategoryOption[]}
      shops={shopsRes.data ?? []}
      deliveries={deliveries}
    />
  );
}
