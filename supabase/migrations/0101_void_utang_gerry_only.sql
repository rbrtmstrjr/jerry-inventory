-- ---------------------------------------------------------------------------
-- 0101 — Voiding an utang payment is Gerry's alone (0099 pt 3).
--
-- A payment posts immediately (0026) — collecting money a customer already
-- owes is bookkeeping, not a stock decision. The VOID was the one way that
-- record could be un-rung, and it belonged to the same shop that recorded it:
-- the person holding the cash could erase its paper trail (control was
-- detective — alert + struck-through entry — not preventive).
--
-- At the owner's request the void moves to the TOP of the tier, above even
-- the admin: only is_primary_owner() may void. A mistaken payment now means
-- the shop (or the office) calls Gerry, exactly like a price correction
-- (0100). Everything else about the function is byte-identical to 0026:
-- soft-delete, owner_note, settled_at rollback, and the office alert.
--
-- The daily flow is untouched: shops still RECORD payments instantly.
-- ---------------------------------------------------------------------------

create or replace function public.fn_void_utang_payment(
  p_id uuid,
  p_reason text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_p record;
  v_shop_name text;
begin
  select * into v_p from utang_payments
  where id = p_id and deleted_at is null
  for update;
  if not found then
    raise exception 'Payment not found';
  end if;

  -- 0101: Gerry alone — a recorded payment is erased only by the owner
  if not public.is_primary_owner() then
    raise exception 'Only the owner can void a payment';
  end if;

  update utang_payments
  set deleted_at = now(),
      owner_note = coalesce(nullif(trim(coalesce(p_reason, '')), ''), owner_note)
  where id = p_id;

  -- balance rose again → the sale is no longer settled
  if public.fn_sale_balance(v_p.sale_id) > 0 then
    update sales set settled_at = null
    where id = v_p.sale_id and settled_at is not null;
  end if;

  select name into v_shop_name from shops where id = v_p.shop_id;
  perform public.fn_notify(
    'owner', v_p.shop_id, 'utang_payment_voided',
    '₱' || to_char(v_p.amount_centavos / 100.0, 'FM999,999,990.00')
      || ' utang payment voided',
    coalesce(v_shop_name, 'A shop') || ' payment voided by the owner · balance restored to ₱'
      || to_char(public.fn_sale_balance(v_p.sale_id) / 100.0, 'FM999,999,990.00'),
    'utang_payments', p_id);
end $$;
