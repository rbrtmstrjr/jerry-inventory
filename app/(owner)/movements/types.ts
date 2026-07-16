/** Row shapes for the movements ledger (matches 0045). */

/** One readable row of `movement_journal`. */
export interface JournalRow {
  id: string;
  created_at: string;
  movement_type: string;
  /** 'master' | 'shop' | 'transit'. `transit` is transit_writeoff only — see 0045. */
  location_kind: string;
  shop_id: string | null;
  location_label: string;
  part_id: string | null;
  engine_id: string | null;
  product_name: string | null;
  sku: string | null;
  serial_number: string | null;
  unit: string;
  qty_change: number;
  qty_in: number;
  qty_out: number;
  /** Resolved from the originating loss — there is no reason column on the ledger. */
  reason: string | null;
  note: string | null;
  actor: string | null;
  actor_name: string | null;
  sale_id: string | null;
  loss_id: string | null;
  delivery_id: string | null;
  return_id: string | null;
  receiving_id: string | null;
  receipt_no: string | null;
}

/** One row of `fn_stock_card` — an opening row, then movements. */
export interface StockCardRow {
  kind: "opening" | "movement";
  movement_id: string | null;
  created_at: string;
  movement_type: string | null;
  reference: string | null;
  particulars: string | null;
  qty_in: number | null;
  qty_out: number | null;
  /** Running balance AFTER this row — computed server-side over the full series. */
  balance: number;
}

export interface EngineLife {
  engine_id: string;
  serial_number: string;
  brand: string | null;
  model: string | null;
  horsepower: number | null;
  /** in_master | in_transit | delivered | sold | returned | written_off */
  status: string;
  shop_name: string | null;
  cost_centavos: number;
  sold_at: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  movements: JournalRow[];
  warranty: {
    id: string;
    sold_on: string;
    months: number;
    expires_on: string;
    claims: { id: string; claim_date: string; issue: string; status: string }[];
  } | null;
}
