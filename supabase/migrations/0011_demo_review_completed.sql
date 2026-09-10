-- Marks a finished simulated review.
--
-- The demo reviewer's final step writes demo_review_completed alongside the
-- decision, and no column existed for it, so the whole review ran through six
-- steps and then failed on the seventh -- the one that actually publishes the
-- decision and flips report_ready. The claim was left stuck in in_review.
--
-- Found by running the review against a stub that enforced the live column
-- list, rather than by reading the code: the previous attempt at that sweep
-- used a regex and mistook nested jsonb keys for columns.
--
-- Off both update allowlists, like the other demo_review_* columns: the
-- service key writes them and no signed-in user needs to.
--
-- Additive and idempotent.

alter table public.cases
  add column if not exists demo_review_completed boolean not null default false;
