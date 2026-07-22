-- 0069 — enum values for warranty-claim resolution (0070)
--
-- `engine_status += 'defective'`: a warranty replacement (0070) sends the
-- customer a good unit and takes the DEFECTIVE one back. The defective engine
-- returns to master but must NEVER re-enter sellable stock — the owner ships it
-- to the supplier (RMA) out of band. A dedicated status parks it: every
-- sellable view filters on `in_master` / `delivered`, so `defective` engines are
-- invisible to sale, delivery, transfer, and the shop's on-hand list.
--
-- `loss_reason += 'warranty'`: the replacement engine leaves stock at ₱0 (no
-- revenue) — its cost is booked as an approved loss (business shrinkage). None
-- of the existing reasons fit a warranty give-away, so it gets its own.
--
-- Enum values cannot be added AND used in the same transaction (see 0027), so
-- these adds live in their own migration; 0070 is the first to use them.

alter type public.engine_status add value if not exists 'defective';
alter type public.loss_reason add value if not exists 'warranty';
