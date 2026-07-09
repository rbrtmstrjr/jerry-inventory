-- ============================================================================
-- 0003_seed.sql — Idempotent reference data
-- ============================================================================

-- Part / goods categories
insert into public.product_categories (name) values
  ('Engine Parts'),
  ('Oil & Lubricants'),
  ('Fisherman Gear'),
  ('Consumables')
on conflict (name) do nothing;

-- Common PH outboard engine models (reference catalog; owner can add more)
insert into public.engine_models (brand, model, horsepower, stroke, default_warranty_months) values
  ('Yamaha',  'Enduro E40GMHL', 40, '2-stroke', 12),
  ('Yamaha',  'Enduro E15DMHL', 15, '2-stroke', 12),
  ('Yamaha',  'Enduro E8DMHL',   8, '2-stroke', 12),
  ('Yamaha',  'F25GMHL',        25, '4-stroke', 12),
  ('Suzuki',  'DT15AS',         15, '2-stroke', 12),
  ('Suzuki',  'DT40WS',         40, '2-stroke', 12),
  ('Suzuki',  'DF20AS',         20, '4-stroke', 12),
  ('Tohatsu', 'M18E2',          18, '2-stroke', 12),
  ('Tohatsu', 'M40D2',          40, '2-stroke', 12),
  ('Honda',   'BF20DK2',        20, '4-stroke', 12),
  ('Mercury', '15MH',           15, '2-stroke', 12)
on conflict (brand, model) do nothing;

-- Sample shops (rename in Shops & Employees)
insert into public.shops (id, name, location) values
  ('a0000000-0000-4000-8000-000000000001', 'Branch 1 — Poblacion', 'Poblacion'),
  ('a0000000-0000-4000-8000-000000000002', 'Branch 2 — Fish Port', 'Fish Port')
on conflict (id) do nothing;

-- Settings row
insert into public.settings (id, business_name, default_warranty_months)
values (1, 'Jerry''s Marine', 12)
on conflict (id) do nothing;
