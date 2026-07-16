-- ============================================================================
-- 0038_sale_line_costs_owner_only.sql — move the COGS snapshot OFF sale_lines.
--
-- 0037 put unit_cost_centavos on sale_lines. That was a cost leak:
-- `sale_lines_select` lets an employee read every line of their own shop's
-- sales (they need to, for Submissions), so the cost column rode along with it.
-- Employees must never see cost — that rule is the backbone of this schema
-- (shop_stock / shop_engines exist purely to strip cost out).
--
-- Column-level grants can't save it either: the owner and employees are both
-- the `authenticated` role, so revoking the column would blind the owner too.
-- Cost therefore cannot live on an employee-readable table at all. It moves to
-- its own owner-only table, joined back by sale_line_id.
--
-- Caught by test-shop-profitability.mjs ("employee cannot read cost through
-- sale_lines"), which is exactly why that assertion exists.
-- ============================================================================

create table if not exists public.sale_line_costs (
  sale_line_id uuid primary key references public.sale_lines(id) on delete cascade,
  sale_id uuid not null references public.sales(id) on delete cascade,
  unit_cost_centavos bigint not null check (unit_cost_centavos >= 0),
  line_cost_centavos bigint not null check (line_cost_centavos >= 0),
  created_at timestamptz not null default now()
);

comment on table public.sale_line_costs is
  'COGS basis frozen at approval. OWNER-ONLY — never exposed to shops.';

create index if not exists idx_sale_line_costs_sale on public.sale_line_costs (sale_id);

alter table public.sale_line_costs enable row level security;

drop policy if exists sale_line_costs_all on public.sale_line_costs;
create policy sale_line_costs_all on public.sale_line_costs
  for all to authenticated
  using (public.is_owner())
  with check (public.is_owner());

-- Carry over what 0037 already stamped/backfilled, then drop the leaky column.
insert into public.sale_line_costs (sale_line_id, sale_id, unit_cost_centavos, line_cost_centavos)
select sl.id, sl.sale_id, sl.unit_cost_centavos, sl.unit_cost_centavos * sl.qty
  from public.sale_lines sl
 where sl.unit_cost_centavos is not null
on conflict (sale_line_id) do nothing;

drop index if exists idx_sale_lines_cost;
alter table public.sale_lines drop column if exists unit_cost_centavos;

-- ---------------------------------------------------------------------------
-- fn_approve_sale — stamp into sale_line_costs instead of onto the line.
-- Body otherwise identical to 0037.
-- ---------------------------------------------------------------------------
create or replace function public.fn_approve_sale(p_sale_id uuid, p_note text default null::text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_sale record;
  l record;
  v_qty int;
  v_eng record;
  v_months int;
  v_sold_on date;
  v_cost bigint;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can approve sales';
  end if;

  select * into v_sale from sales
  where id = p_sale_id and deleted_at is null
  for update;

  if v_sale is null then
    raise exception 'Sale not found';
  end if;
  if v_sale.status not in ('pending','questioned') then
    raise exception 'Sale already reviewed (status: %)', v_sale.status;
  end if;

  for l in
    select * from sale_lines where sale_id = p_sale_id
  loop
    if l.part_id is not null then
      select qty into v_qty from stock_levels
      where part_id = l.part_id and shop_id = v_sale.shop_id
      for update;

      if v_qty is null or v_qty < l.qty then
        raise exception 'Cannot approve: % would drive shop stock negative (on hand: %, selling: %)',
          coalesce(l.description, 'item'), coalesce(v_qty, 0), l.qty;
      end if;

      update stock_levels set qty = qty - l.qty
      where part_id = l.part_id and shop_id = v_sale.shop_id;

      insert into stock_movements (movement_type, part_id, qty_change, shop_id, actor, sale_id, note)
      values ('sale', l.part_id, -l.qty, v_sale.shop_id, auth.uid(), p_sale_id, l.description);

      select cost_centavos into v_cost from parts where id = l.part_id;

    else
      select e.*, em.default_warranty_months into v_eng
      from engines e
      join engine_models em on em.id = e.engine_model_id
      where e.id = l.engine_id and e.deleted_at is null
      for update of e;

      if v_eng is null then
        raise exception 'Engine on this sale no longer exists';
      end if;
      if v_eng.status <> 'delivered' or v_eng.shop_id is distinct from v_sale.shop_id then
        raise exception 'Cannot approve: engine % is not at this shop anymore (status: %)',
          v_eng.serial_number, v_eng.status;
      end if;
      if v_sale.customer_id is null then
        raise exception 'Engine sales need a customer before approval';
      end if;

      update engines
      set status = 'sold', customer_id = v_sale.customer_id, sold_at = now()
      where id = l.engine_id;

      -- auto-create the warranty: engine override → model default → settings
      v_months := coalesce(
        v_eng.warranty_months,
        v_eng.default_warranty_months,
        (select default_warranty_months from settings where id = 1),
        12
      );
      v_sold_on := public.ph_today();

      insert into warranties (engine_id, sale_id, customer_id, sold_on, months, expires_on)
      values (l.engine_id, p_sale_id, v_sale.customer_id, v_sold_on, v_months,
              (v_sold_on + (v_months || ' months')::interval)::date)
      on conflict (engine_id) do update
        set sale_id = excluded.sale_id,
            customer_id = excluded.customer_id,
            sold_on = excluded.sold_on,
            months = excluded.months,
            expires_on = excluded.expires_on,
            deleted_at = null;

      insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, sale_id, note)
      values ('sale', l.engine_id, -1, v_sale.shop_id, auth.uid(), p_sale_id, l.description);

      -- this exact serial's own cost
      v_cost := v_eng.cost_centavos;
    end if;

    -- Freeze the COGS basis. parts.cost_centavos is mutable, so reading it at
    -- report time would let an edit silently rewrite past profit.
    insert into sale_line_costs (sale_line_id, sale_id, unit_cost_centavos, line_cost_centavos)
    values (l.id, p_sale_id, coalesce(v_cost, 0), coalesce(v_cost, 0) * l.qty)
    on conflict (sale_line_id) do update
      set unit_cost_centavos = excluded.unit_cost_centavos,
          line_cost_centavos = excluded.line_cost_centavos;
  end loop;

  update sales
  set status = 'approved',
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      owner_note = coalesce(p_note, owner_note)
  where id = p_sale_id;
end $function$;

revoke all on function public.fn_approve_sale(uuid, text) from public, anon;
grant execute on function public.fn_approve_sale(uuid, text) to authenticated;
