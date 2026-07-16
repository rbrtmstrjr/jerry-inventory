// Row shapes used by the UI (hand-maintained; matches supabase/migrations)

/**
 * Business identity as printed on the six documents, read from the
 * `public_settings` view (0043).
 *
 * The view — not the `settings` table — because `settings` is owner-only, and
 * two of these documents are printed by SHOPS (the sale receipt after every
 * sale, and the shop's warranty certificate). Reading the table there returned
 * NULL and the page silently fell back to a hardcoded name with no address or
 * footer, so the copy a customer got was worse than the owner's reprint of the
 * same sale. The view exposes these columns and nothing else — no operating
 * thresholds, no payroll dials.
 */
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

export interface EngineModel {
  id: string;
  brand: string;
  model: string;
  horsepower: number | null;
  stroke: string | null;
  default_warranty_months: number;
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
  // Owner-set negotiation margins (%) — null until configured
  margin_floor_pct: number | null;
  margin_mid_pct: number | null;
  margin_asking_pct: number | null;
  // Computed tier prices (centavos), kept in sync by a DB trigger
  price_floor_centavos: number | null;
  price_mid_centavos: number | null;
  price_asking_centavos: number | null;
  warranty_months: number | null;
  status: "in_master" | "delivered" | "sold" | "returned";
  shop_name: string | null;
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

// Employee-safe view rows (NO cost fields exist on these)
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
  // Three negotiable selling prices (NO cost/margin exposed to shops)
  price_floor_centavos: number;
  price_mid_centavos: number;
  price_asking_centavos: number;
  status: string;
  shop_id: string;
  image_path: string | null;
}

/**
 * One open (or settled) partial-payment sale. Balance is computed in the DB:
 * total − amount_paid_at_sale − Σ(approved payments). Selling prices only.
 */
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

// ---------------------------------------------------------------------------
// Government contributions (SSS / PhilHealth / Pag-IBIG)
// ---------------------------------------------------------------------------

export type ContributionAgency = "sss" | "philhealth" | "pagibig";

/**
 * One agency's FROZEN snapshot for one payroll entry
 * (`payroll_entry_contributions`). The amounts were computed when the entry was
 * saved and are never recomputed — editing the rate book must not rewrite a
 * past payslip. Read these; never derive them from `contribution_brackets`.
 */
export interface EntryContribution {
  agency: ContributionAgency;
  /** Monthly basis the amounts were computed from. */
  salary_basis_centavos: number;
  /** SSS Monthly Salary Credit actually used; null for the other agencies. */
  credited_salary_centavos: number | null;
  /** Employee share — deducted from gross. */
  ee_amount_centavos: number;
  /** Employer share — the company's cost. NEVER deducted from the worker. */
  er_amount_centavos: number;
}

/** Per-agency period totals from `fn_remittance_totals`. */
export interface RemittanceTotal {
  agency: ContributionAgency;
  staff_count: number;
  ee_total_centavos: number;
  er_total_centavos: number;
  total_centavos: number;
}

// ---------------------------------------------------------------------------
// Government contributions — the rate book.
//
// RATES ARE DATA, NOT CODE. Nothing here (or anywhere in app code) may carry a
// rate, bracket, MSC, floor or ceiling as a literal. Every value below is read
// from `contribution_brackets`, which the owner edits from Settings when an
// agency issues a new circular.
// ---------------------------------------------------------------------------

// `ContributionAgency` is declared once, with the frozen-snapshot types above.

/**
 * How a row turns a monthly basis into pesos:
 *  - msc_bracket      percents apply to `credited_salary_centavos` (the SSS
 *                     MSC), NOT to the actual salary
 *  - percent_of_salary percents apply to the basis, clamped to
 *                     basis_floor/basis_ceiling first
 *  - fixed            flat ee/er amounts, whatever the salary
 */
export type ContributionBasis = "msc_bracket" | "percent_of_salary" | "fixed";

export type SemimonthlySplit = "half_each" | "second_cutoff";

export interface ContributionBracketRow {
  id: string;
  agency: ContributionAgency;
  /** null effective_to = still current */
  effective_from: string;
  effective_to: string | null;
  salary_min_centavos: number;
  /** null = open-ended (top bracket) */
  salary_max_centavos: number | null;
  basis: ContributionBasis;
  /** SSS MSC. Percents apply to THIS, not to pay. */
  credited_salary_centavos: number | null;
  /** numeric(6,3) — a percentage, NOT money. Never touch centavo helpers. */
  ee_percent: number;
  er_percent: number;
  basis_floor_centavos: number | null;
  basis_ceiling_centavos: number | null;
  /** employer-only add-on that is not a percentage (SSS EC) */
  er_extra_centavos: number;
  /** basis='fixed' only */
  ee_amount_centavos: number | null;
  er_amount_centavos: number | null;
  note: string | null;
  /** the circular this row came from */
  source_ref: string | null;
}

/** fn_resolve_contribution — the DB's own answer, used for the live preview. */
export interface ResolvedContribution {
  bracket_id: string;
  credited_salary_centavos: number | null;
  ee_amount_centavos: number;
  er_amount_centavos: number;
}
