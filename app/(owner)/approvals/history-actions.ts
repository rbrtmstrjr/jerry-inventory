"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

/**
 * Read-only detail for one reviewed item. Nothing here mutates — the history
 * can never re-approve, reverse, or move stock.
 * Owner-only: every table read is owner-scoped by RLS, and /approvals lives in
 * the owner route group.
 */

export interface MovementRow {
  movement_type: string;
  qty_change: number;
  at: string;
  where: string;
  item: string;
  note: string | null;
}

export interface SaleLineDetail {
  description: string;
  qty: number;
  unit_price_centavos: number;
  line_total_centavos: number;
  is_engine: boolean;
  serial_number: string | null;
  model: string | null;
  agreed_price_centavos: number | null;
  list_reference_centavos: number | null;
  discount_centavos: number | null;
  floor_centavos: number | null;
  /** owner-only — never leaves this page */
  cost_centavos: number | null;
}

export interface SaleDetail {
  type: "sale";
  id: string;
  shop_name: string;
  status: string;
  created_at: string;
  business_date: string;
  reviewed_at: string | null;
  recorded_by: string;
  reviewed_by: string | null;
  owner_note: string | null;
  batch_submitted_at: string | null;
  lines: SaleLineDetail[];
  total_centavos: number;
  payment_type: string;
  amount_paid_centavos: number | null;
  balance_due_centavos: number;
  receipt_no: string | null;
  customer: { id: string; name: string; phone: string | null } | null;
  warranty_id: string | null;
  movements: MovementRow[];
}

export interface LossDetail {
  type: "loss";
  id: string;
  shop_name: string;
  status: string;
  created_at: string;
  business_date: string;
  reviewed_at: string | null;
  recorded_by: string;
  reviewed_by: string | null;
  owner_note: string | null;
  batch_submitted_at: string | null;
  description: string;
  qty: number;
  reason: string;
  note: string | null;
  value_centavos: number | null;
  serial_number: string | null;
  movements: MovementRow[];
}

export interface PaymentDetail {
  type: "utang_payment";
  id: string;
  shop_name: string;
  status: string;
  created_at: string;
  business_date: string;
  recorded_by: string;
  note: string | null;
  amount_centavos: number;
  customer: { id: string; name: string; phone: string | null } | null;
  sale: {
    id: string;
    receipt_no: string | null;
    total_centavos: number;
    amount_paid_centavos: number | null;
  } | null;
  balance_before_centavos: number;
  balance_after_centavos: number;
}

export interface ExpenseDetail {
  type: "expense";
  id: string;
  shop_name: string;
  status: string;
  created_at: string;
  expense_date: string;
  approved_at: string | null;
  recorded_by: string;
  approved_by: string | null;
  review_note: string | null;
  batch_submitted_at: string | null;
  amount_centavos: number;
  category_name: string;
  category_proposed: boolean;
  description: string;
  paid_to: string | null;
  payment_method: string | null;
  reference_no: string | null;
  receipt_image_path: string | null;
}

export type ReviewedDetail = SaleDetail | LossDetail | PaymentDetail | ExpenseDetail;

/* eslint-disable @typescript-eslint/no-explicit-any */
const label = (m: any) =>
  m.parts?.name ?? m.engines?.serial_number ?? "Item";

function mapMovements(rows: any[], shopName: string): MovementRow[] {
  return (rows ?? []).map((m: any) => ({
    movement_type: m.movement_type,
    qty_change: m.qty_change,
    at: m.created_at,
    where: m.shop_id ? shopName : "Master",
    item: label(m),
    note: m.note,
  }));
}

export async function getReviewedDetail(
  itemType: string,
  id: string
): Promise<{ ok: true; detail: ReviewedDetail } | { ok: false; error: string }> {
  const parsed = z
    .object({
      itemType: z.enum(["sale", "loss", "utang_payment", "expense"]),
      id: z.uuid(),
    })
    .safeParse({ itemType, id });
  if (!parsed.success) return { ok: false, error: "Invalid item" };

  const supabase = await createClient();

  // ───────────────────────────── SALE ─────────────────────────────
  if (parsed.data.itemType === "sale") {
    const { data, error } = await supabase
      .from("sales")
      .select(
        `id, business_date, status, total_centavos, payment_type, amount_paid_centavos,
         balance_due_centavos, receipt_no, owner_note, created_at, reviewed_at,
         shops(name),
         customers(id, name, phone),
         recorded:profiles!sales_recorded_by_fkey(full_name),
         reviewer:profiles!sales_reviewed_by_fkey(full_name),
         submission_batches(submitted_at),
         sale_lines(description, qty, unit_price_centavos, line_total_centavos, engine_id, part_id,
                    agreed_price_centavos, list_reference_centavos, discount_centavos, created_at,
                    engines(serial_number, cost_centavos,
                            engine_models(brand, model, horsepower)),
                    parts(name, cost_centavos))`
      )
      .eq("id", parsed.data.id)
      .is("deleted_at", null)
      .single();
    if (error || !data) return { ok: false, error: error?.message ?? "Not found" };
    const s = data as any;
    const shopName = s.shops?.name ?? "?";

    const [wRes, mRes] = await Promise.all([
      supabase.from("warranties").select("id").eq("sale_id", s.id).maybeSingle(),
      supabase
        .from("stock_movements")
        .select(
          "movement_type, qty_change, shop_id, created_at, note, parts(name), engines(serial_number)"
        )
        .eq("sale_id", s.id)
        .order("created_at"),
    ]);

    const lines: SaleLineDetail[] = [...(s.sale_lines ?? [])]
      .sort((a: any, b: any) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))
      .map((l: any) => ({
        description: l.description ?? "Item",
        qty: l.qty,
        unit_price_centavos: l.unit_price_centavos,
        line_total_centavos: l.line_total_centavos,
        is_engine: !!l.engine_id,
        serial_number: l.engines?.serial_number ?? null,
        model: l.engines?.engine_models
          ? `${l.engines.engine_models.brand} ${l.engines.engine_models.model}${
              l.engines.engine_models.horsepower != null
                ? ` — ${l.engines.engine_models.horsepower}HP`
                : ""
            }`
          : null,
        agreed_price_centavos: l.agreed_price_centavos ?? null,
        list_reference_centavos: l.list_reference_centavos ?? null,
        discount_centavos: l.discount_centavos ?? null,
        floor_centavos: l.engines?.cost_centavos ?? null, // floor = cost since 0053
        cost_centavos: l.engines?.cost_centavos ?? l.parts?.cost_centavos ?? null,
      }));

    return {
      ok: true,
      detail: {
        type: "sale",
        id: s.id,
        shop_name: shopName,
        status: s.status,
        created_at: s.created_at,
        business_date: s.business_date,
        reviewed_at: s.reviewed_at,
        recorded_by: s.recorded?.full_name ?? "?",
        reviewed_by: s.reviewer?.full_name ?? null,
        owner_note: s.owner_note,
        batch_submitted_at: s.submission_batches?.submitted_at ?? null,
        lines,
        total_centavos: s.total_centavos,
        payment_type: s.payment_type ?? "full",
        amount_paid_centavos: s.amount_paid_centavos,
        balance_due_centavos: s.balance_due_centavos ?? 0,
        receipt_no: s.receipt_no,
        customer: s.customers
          ? { id: s.customers.id, name: s.customers.name, phone: s.customers.phone }
          : null,
        warranty_id: wRes.data?.id ?? null,
        movements: mapMovements(mRes.data ?? [], shopName),
      },
    };
  }

  // ───────────────────────────── LOSS ─────────────────────────────
  if (parsed.data.itemType === "loss") {
    const { data, error } = await supabase
      .from("losses")
      .select(
        `id, business_date, status, qty, reason, note, owner_note, value_centavos,
         created_at, reviewed_at, description,
         shops(name),
         recorded:profiles!losses_recorded_by_fkey(full_name),
         reviewer:profiles!losses_reviewed_by_fkey(full_name),
         submission_batches(submitted_at),
         engines(serial_number)`
      )
      .eq("id", parsed.data.id)
      .is("deleted_at", null)
      .single();
    if (error || !data) return { ok: false, error: error?.message ?? "Not found" };
    const l = data as any;
    const shopName = l.shops?.name ?? "?";

    const { data: mv } = await supabase
      .from("stock_movements")
      .select(
        "movement_type, qty_change, shop_id, created_at, note, parts(name), engines(serial_number)"
      )
      .eq("loss_id", l.id)
      .order("created_at");

    return {
      ok: true,
      detail: {
        type: "loss",
        id: l.id,
        shop_name: shopName,
        status: l.status,
        created_at: l.created_at,
        business_date: l.business_date,
        reviewed_at: l.reviewed_at,
        recorded_by: l.recorded?.full_name ?? "?",
        reviewed_by: l.reviewer?.full_name ?? null,
        owner_note: l.owner_note,
        batch_submitted_at: l.submission_batches?.submitted_at ?? null,
        description: l.description ?? "Item",
        qty: l.qty,
        reason: l.reason,
        note: l.note,
        value_centavos: l.value_centavos,
        serial_number: l.engines?.serial_number ?? null,
        movements: mapMovements(mv ?? [], shopName),
      },
    };
  }

  // ───────────────────────────── EXPENSE ─────────────────────────────
  if (parsed.data.itemType === "expense") {
    const { data, error } = await supabase
      .from("expenses")
      .select(
        `id, amount, expense_date, status, description, paid_to, payment_method,
         reference_no, receipt_image_path, review_note, created_at, approved_at,
         shops(name),
         expense_categories(name, status),
         recorded:profiles!expenses_recorded_by_fkey(full_name),
         approver:profiles!expenses_approved_by_fkey(full_name),
         submission_batches(submitted_at)`
      )
      .eq("id", parsed.data.id)
      .is("deleted_at", null)
      .single();
    if (error || !data) return { ok: false, error: error?.message ?? "Not found" };
    const e = data as any;

    return {
      ok: true,
      detail: {
        type: "expense",
        id: e.id,
        shop_name: e.shops?.name ?? "?",
        status: e.status,
        created_at: e.created_at,
        expense_date: e.expense_date,
        approved_at: e.approved_at,
        recorded_by: e.recorded?.full_name ?? "?",
        approved_by: e.approver?.full_name ?? null,
        review_note: e.review_note,
        batch_submitted_at: e.submission_batches?.submitted_at ?? null,
        amount_centavos: e.amount,
        category_name: e.expense_categories?.name ?? "?",
        category_proposed: e.expense_categories?.status === "proposed",
        description: e.description,
        paid_to: e.paid_to,
        payment_method: e.payment_method,
        reference_no: e.reference_no,
        receipt_image_path: e.receipt_image_path,
      },
    };
  }

  // ───────────────────────── UTANG PAYMENT ─────────────────────────
  const { data, error } = await supabase
    .from("utang_payments")
    .select(
      `id, business_date, status, amount_centavos, note, created_at,
       shops(name),
       customers(id, name, phone),
       recorded:profiles!utang_payments_recorded_by_fkey(full_name),
       sales(id, receipt_no, total_centavos, amount_paid_centavos)`
    )
    .eq("id", parsed.data.id)
    .is("deleted_at", null)
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "Not found" };
  const p = data as any;

  // Balance before → after: replay the approved payments that landed before
  // this one, so the drawer shows the effect of THIS payment specifically.
  let before = 0;
  let after = 0;
  if (p.sales) {
    const { data: prior } = await supabase
      .from("utang_payments")
      .select("id, amount_centavos, created_at")
      .eq("sale_id", p.sales.id)
      .eq("status", "approved")
      .is("deleted_at", null)
      .lte("created_at", p.created_at);
    const sumBefore = (prior ?? [])
      .filter(
        (x: any) =>
          x.created_at < p.created_at ||
          (x.created_at === p.created_at && x.id < p.id)
      )
      .reduce((s: number, x: any) => s + x.amount_centavos, 0);
    before =
      p.sales.total_centavos - (p.sales.amount_paid_centavos ?? 0) - sumBefore;
    after = before - p.amount_centavos;
  }

  return {
    ok: true,
    detail: {
      type: "utang_payment",
      id: p.id,
      shop_name: p.shops?.name ?? "?",
      status: p.status,
      created_at: p.created_at,
      business_date: p.business_date,
      recorded_by: p.recorded?.full_name ?? "?",
      note: p.note,
      amount_centavos: p.amount_centavos,
      customer: p.customers
        ? { id: p.customers.id, name: p.customers.name, phone: p.customers.phone }
        : null,
      sale: p.sales
        ? {
            id: p.sales.id,
            receipt_no: p.sales.receipt_no,
            total_centavos: p.sales.total_centavos,
            amount_paid_centavos: p.sales.amount_paid_centavos,
          }
        : null,
      balance_before_centavos: before,
      balance_after_centavos: after,
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
