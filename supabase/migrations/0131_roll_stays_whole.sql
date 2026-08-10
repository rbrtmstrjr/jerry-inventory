-- ---------------------------------------------------------------------------
-- 0131 — `roll` sells WHOLE again (reverts the roll arm of 0130).
--
-- Gerry's clarification arrived after 0130 was verified on staging: a part
-- roll is sold AS A ROLL — a customer who wants part of one buys the
-- by-the-metre product instead, which 0130 already made splittable. `0.5 roll`
-- was never a real sale, so offering it invites a mis-keyed cart line.
--
-- Same shape as 0130 and for the same reason: the vocabulary is DATA (0114),
-- so the revert is an UPDATE, not code. `m` and `ft` keep their tenths.
--
-- No quantity backfill: the flag only ever PERMITTED tenths, and any
-- fractional roll quantity recorded on staging in the window stays a valid
-- historical fact (the 0116 rule). Production never sees the window at all —
-- 0130 and 0131 land there in the same push.
-- ---------------------------------------------------------------------------

update public.units set allows_fractional = false
 where code = 'roll';

-- Loud verification (0130's own pattern): a missing or retired row would make
-- the UPDATE a silent no-op that reports success.
do $$
begin
  if not exists (
    select 1 from public.units
     where code = 'roll'
       and not allows_fractional
       and deleted_at is null) then
    raise exception '0131 did not land: roll is missing, retired, or still fractional';
  end if;
end $$;
