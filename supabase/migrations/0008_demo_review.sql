-- Demo reviewer state.
--
-- The simulated adjuster tracks its progress on the case itself:
-- demo_review_cursor is which step it is on, demo_review_state carries what
-- it worked out along the way, and review_steps is the visible audit trail
-- the employee portal renders. None of these existed as columns, so every
-- demo step would have failed with PGRST204.
--
-- demo_review_cursor is nullable on purpose: null means "not enrolled", which
-- is how enroll() and advance() tell an untouched claim from one mid-review.
-- A default of 0 would make every claim look enrolled.
--
-- These stay off both update allowlists. The demo reviewer writes them with
-- the service key, which bypasses RLS, so no signed-in user needs permission
-- to touch them -- and a customer being able to set their own review_steps
-- would let them fabricate an audit trail.
--
-- Additive and idempotent.

alter table public.cases
  add column if not exists demo_review_cursor integer,
  add column if not exists demo_review_state  jsonb not null default '{}'::jsonb,
  add column if not exists review_steps       jsonb not null default '[]'::jsonb;
