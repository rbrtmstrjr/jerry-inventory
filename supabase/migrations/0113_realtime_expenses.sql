-- 0113 — expenses joins the realtime publication.
--
-- Shop-recorded expenses (0051) ride the submission batch like sales and losses,
-- and the Approval Queue subscribes to them:
--     app/(owner)/approvals/approvals-view.tsx  → postgres_changes on 'expenses'
-- but `expenses` was never added to `supabase_realtime`, so that subscription has
-- always been silent. Every other table the app subscribes to (sales, losses,
-- notifications) was added by 0008/0022/0025; expenses was simply missed when
-- 0051 introduced the feature.
--
-- Visible effect: a shop submits a batch containing ONLY expenses (a normal day
-- with no sales — a fuel or rent receipt), the rows flip to `pending`, and the
-- owner's queue does not update until the page is manually reloaded. It looks
-- like the shop never submitted.
--
-- Additive and idempotent: adding a table to a publication changes no data and
-- no policy. RLS still decides what each subscriber may see — a publication only
-- controls what is BROADCAST, never who may read it.
do $$
begin
  alter publication supabase_realtime add table public.expenses;
exception
  when duplicate_object then null;  -- already published
end $$;
