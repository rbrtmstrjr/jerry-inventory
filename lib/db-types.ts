// Row shapes used by the UI (hand-maintained; matches supabase/migrations)

/** Business identity for the printed documents, read from `public_settings` —
 *  the `settings` table is owner-only and shops print two of these. */
export interface BusinessIdentity {
  business_name: string;
  address: string | null;
  phone: string | null;
  business_email: string | null;
  business_tin: string | null;
  receipt_footer: string | null;
}

export interface Category {
  id: string;
  name: string;
}

/** Minimal shop reference for pickers and ShopBadge coloring. */
export interface ShopOption {
  id: string;
  name: string;
  color_key: string | null;
}

export interface EngineModel {
  id: string;
  brand: string;
  model: string;
  horsepower: number | null;
  stroke: string | null;
  default_warranty_months: number;
  /** 0128: OFF lets Receiving take a qty instead of one serial per unit. */
  is_serialized: boolean;
  sku: string | null;
}

export interface PartRow {
  id: string;
  name: string;
  category_id: string | null;
  category_name: string | null;
  sku: string | null;
  barcode: string | null;
  unit: string;
  cost_centavos: number;
  price_centavos: number;
  reorder_level: number;
  notes: string | null;
  image_path: string | null;
  master_qty: number;
  /** on-hand across ALL locations (master + shops) — merge blocks on any stock */
  total_qty: number;
}

export interface EngineRow {
  id: string;
  serial_number: string;
  engine_model_id: string;
  brand: string;
  model: string;
  horsepower: number | null;
  condition: "brand_new" | "second_hand";
  cost_centavos: number;
  price_centavos: number;
  warranty_months: number | null;
  // The FULL engine_status enum. A narrower type makes a Record<> look
  // exhaustive to tsc while the DB emits values it has no key for.
  status:
    | "in_master"
    | "in_transit"
    | "delivered"
    | "sold"
    | "returned"
    | "defective";
  shop_name: string | null;
  shop_color_key: string | null;
  image_path: string | null;
}

export interface SupplierRow {
  id: string;
  name: string;
  contact: string | null;
  notes: string | null;
  /** centavos; null = no limit. Warns + needs an override — never blocks. */
  credit_limit?: number | null;
  payment_terms_days?: number | null;
  terms_note?: string | null;
  /** joined from supplier_payables for the inline debt display */
  outstanding?: number;
  utilization_pct?: number | null;
}

/** Per-supplier payables rollup (owner-only view). */
export interface SupplierPayableRow {
  supplier_id: string;
  supplier_name: string;
  contact: string | null;
  credit_limit: number | null;
  payment_terms_days: number | null;
  terms_note: string | null;
  outstanding: number;
  open_count: number;
  oldest_due_date: string | null;
  overdue_amount: number;
  overdue_count: number;
  utilization_pct: number | null;
}

/** One receiving's open balance (owner-only view). */
export interface ReceivingBalanceRow {
  receiving_id: string;
  supplier_id: string | null;
  supplier_name: string | null;
  received_at: string;
  due_date: string | null;
  note: string | null;
  total_amount: number;
  amount_paid: number;
  paid_since: number;
  balance: number;
  payment_status: "unpaid" | "partial" | "paid";
  settled_at: string | null;
  limit_override: boolean;
  limit_override_reason: string | null;
  overdue: boolean;
  days_overdue: number | null;
}

// Employee-safe view rows. These carry the OWN-SHOP unit cost (the tawad floor)
// and nothing else about cost — every other cost surface stays owner-only.
export interface ShopStockRow {
  shop_id: string;
  part_id: string;
  name: string;
  category: string | null;
  sku: string | null;
  barcode: string | null;
  unit: string;
  price_centavos: number;
  reorder_level: number;
  image_path: string | null;
  qty: number;
  cost_centavos: number;
}

export interface ShopEngineRow {
  engine_id: string;
  serial_number: string;
  brand: string;
  model: string;
  horsepower: number | null;
  stroke: string | null;
  condition: "brand_new" | "second_hand";
  price_centavos: number;
  cost_centavos: number;
  status: string;
  shop_id: string;
  image_path: string | null;
}

/** One partial-payment sale. Balance is computed in the DB (total − paid-at-sale
 *  − Σ approved payments). Selling prices only. */
export interface ReceivableRow {
  sale_id: string;
  receipt_no: string | null;
  business_date: string;
  created_at: string;
  sale_status: "recorded" | "pending" | "questioned" | "approved";
  shop_id: string;
  shop_name: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  total_centavos: number;
  amount_paid_centavos: number;
  paid_since_centavos: number;
  total_paid_centavos: number;
  balance_centavos: number;
  settled_at: string | null;
  description: string | null;
}

/** Master shortage → buy from a supplier (owner-only view). */
export interface MasterLowStockRow {
  kind: "part" | "engine_model";
  product_id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  unit: string;
  on_hand: number;
  threshold: number;
  shortfall: number;
  supplier_id: string | null;
  supplier_name: string | null;
  supplier_contact: string | null;
}

/** Shop shortage → request a delivery. Effective threshold = override ?? default. */
export interface ShopLowStockRow {
  shop_id: string;
  shop_name: string;
  kind: "part" | "engine_model";
  product_id: string;
  name: string;
  unit: string;
  on_hand: number;
  threshold: number;
  shortfall: number;
  threshold_is_override: boolean;
}

export interface ReceivingRow {
  id: string;
  received_at: string;
  note: string | null;
  supplier_name: string | null;
  part_lines: number;
  engine_lines: number;
  total_qty: number;
}
