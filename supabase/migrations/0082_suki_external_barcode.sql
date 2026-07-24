-- ---------------------------------------------------------------------------
-- 0082 — suki cards: record an externally-printed barcode, drop minting
--
-- Gerwin now GENERATES + PRINTS the physical suki cards in a SEPARATE system.
-- This app no longer mints 'SC########' numbers and no longer prints a card —
-- it only RECORDS the barcode number the external system already printed, so
-- the customer can start using the card here. Everything else is unchanged: a
-- card still belongs to one customer, still resolves at POS through
-- fn_lookup_discount_card, still drives the same server-side discount math.
--
-- fn_create_discount_card now takes the owner-entered number (p_card_no) rather
-- than pulling from discount_card_seq. It's stored upper+trimmed to match
-- fn_lookup_discount_card's case-folded compare, and must be unique across all
-- cards (a physical number is unique forever). The 'SC' prefix is no longer
-- required — a card is applied at POS through the dedicated Suki field, so it
-- needs no prefix to be told apart from a product barcode. A lost card is
-- deactivated and a NEW card recorded with its NEW number (no auto-reissue).
--
-- discount_card_seq is left in place, unused — harmless, and dropping it buys
-- nothing. fn_lookup_discount_card / fn_set_discount_card_status are unchanged.
-- ---------------------------------------------------------------------------

drop function if exists public.fn_create_discount_card(uuid, text);

create or replace function public.fn_create_discount_card(
  p_customer_id uuid,
  p_card_no text,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card_no text;
  v_id uuid;
  v_existing text;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can issue suki cards';
  end if;

  v_card_no := upper(trim(coalesce(p_card_no, '')));
  if v_card_no = '' then
    raise exception 'Card number is required';
  end if;

  if not exists (
    select 1 from customers where id = p_customer_id and deleted_at is null
  ) then
    raise exception 'Customer not found';
  end if;

  select card_no into v_existing from discount_cards
  where customer_id = p_customer_id and status = 'active' and deleted_at is null;
  if v_existing is not null then
    raise exception 'That customer already has an active card (%) — deactivate it first',
      v_existing;
  end if;

  if exists (select 1 from discount_cards where card_no = v_card_no) then
    raise exception 'Card number % is already on file', v_card_no;
  end if;

  insert into discount_cards (card_no, customer_id, issued_by, note)
  values (v_card_no, p_customer_id, auth.uid(), nullif(trim(coalesce(p_note,'')), ''))
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'card_no', v_card_no);
end $$;

revoke all on function public.fn_create_discount_card(uuid, text, text) from public, anon;
grant execute on function public.fn_create_discount_card(uuid, text, text) to authenticated;
