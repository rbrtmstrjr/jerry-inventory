import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  ShopExpensesView,
  type CategoryOption,
  type ShopExpenseRow,
} from "./expenses-view";

export const metadata: Metadata = { title: "Expenses" };

export default function ShopExpensesPage() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Expenses</h1>
        <p className="text-sm text-muted-foreground">
          Record what this shop spends — it goes to Admin with your next report
          and only counts once approved.
        </p>
      </div>
      <Suspense fallback={<ShopExpensesSkeleton />}>
        <ShopExpensesBody />
      </Suspense>
    </div>
  );
}

function ShopExpensesSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Skeleton className="h-9 w-36" />
      </div>
      <Skeleton className="h-16 w-full rounded-lg" />
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-5 w-40" />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

async function ShopExpensesBody() {
  const supabase = await createClient();
  const profile = await getProfile();

  const [expensesRes, categoriesRes] = await Promise.all([
    // RLS scopes this to the caller's own shop (both shop- and Admin-recorded)
    supabase
      .from("expenses")
      .select(
        "id, amount, expense_date, description, paid_to, payment_method, reference_no, receipt_image_path, status, source, review_note, created_at, expense_categories(name)"
      )
      .is("deleted_at", null)
      .order("expense_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(300),
    supabase
      .from("expense_categories")
      .select("id, name, sort_order")
      .eq("status", "active")
      .is("deleted_at", null)
      .order("sort_order")
      .order("name"),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const expenses: ShopExpenseRow[] = (expensesRes.data ?? []).map((e: any) => ({
    id: e.id,
    amount: e.amount,
    expense_date: e.expense_date,
    description: e.description,
    paid_to: e.paid_to,
    payment_method: e.payment_method,
    reference_no: e.reference_no,
    receipt_image_path: e.receipt_image_path,
    status: e.status,
    source: e.source,
    review_note: e.review_note,
    created_at: e.created_at,
    category_name: e.expense_categories?.name ?? "?",
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <ShopExpensesView
      expenses={expenses}
      categories={(categoriesRes.data ?? []) as CategoryOption[]}
      shopId={profile?.shop_id ?? null}
    />
  );
}
