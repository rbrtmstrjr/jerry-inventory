/** One row of `supplier_price_comparison` (0046): product × supplier. */
export interface ComparisonRow {
  supplier_id: string;
  supplier_name: string;
  part_id: string | null;
  engine_model_id: string | null;
  product_name: string;
  sku: string | null;
  unit: string;
  category_name: string | null;
  kind: "part" | "engine_model";
  preferred_supplier_id: string | null;
  is_preferred: boolean;

  /** What was actually handed over, from receiving history. */
  last_paid_centavos: number | null;
  last_paid_at: string | null;
  receiving_id: string | null;

  /** The latest live quote — a claim, not a payment. */
  quote_id: string | null;
  quote_centavos: number | null;
  quoted_at: string | null;
  valid_until: string | null;
  quote_note: string | null;
  /** Past valid_until, or older than settings.quote_stale_days. */
  quote_stale: boolean;

  /** Fresh quote → last-paid → stale quote, with which one it was. */
  effective_centavos: number;
  effective_source: "quote" | "paid" | "stale_quote";
  effective_as_of: string;

  cheapest_centavos: number;
  is_cheapest: boolean;
  /** The preferred supplier's own effective price, on every row of the product. */
  preferred_effective_centavos: number | null;
  supplier_count: number;
}
