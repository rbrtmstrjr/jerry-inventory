// Row shapes used by the UI (hand-maintained; matches supabase/migrations)

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
  status: string;
  shop_id: string;
  image_path: string | null;
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
