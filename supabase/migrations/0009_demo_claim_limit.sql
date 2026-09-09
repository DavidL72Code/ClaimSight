-- Cap how many claims one demo visitor can create.
--
-- The homepage demo signs people in anonymously, so a visitor could otherwise
-- submit claims without limit -- each one costing a Gemini assessment. The cap
-- lives in the insert policy rather than in the frontend because a
-- localStorage counter is cleared by a new incognito window, whereas this is
-- decided by Postgres and cannot be argued with.
--
-- It applies only to anonymous sessions. A real signed-up customer may have as
-- many claims as they like, which is why the check reads the is_anonymous JWT
-- claim rather than counting for everyone.
--
-- Additive and idempotent.

-- Mirrors public.jwt_role(): reads a claim PostgREST puts in the GUC.
create or replace function public.is_anonymous_session()
returns boolean
language sql
stable
as $$
  select coalesce(
    (current_setting('request.jwt.claims', true)::jsonb ->> 'is_anonymous')::boolean,
    false
  );
$$;

-- SECURITY DEFINER so the count is not itself filtered by the cases select
-- policy, which would make it always return the caller's visible rows and
-- recurse while evaluating an insert.
create or replace function public.owner_case_count(target uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int from public.cases where owner_uid = target;
$$;

-- Anonymous visitors do not need to introspect this.
revoke all on function public.is_anonymous_session() from anon;
revoke all on function public.owner_case_count(uuid) from anon;

create or replace function public.demo_claim_limit()
returns integer
language sql
immutable
as $$
  select 5;
$$;

comment on function public.demo_claim_limit() is
  'Maximum claims an anonymous demo visitor may create. Change the returned
   value to adjust the cap; the insert policy reads it, so no policy edit is
   needed.';

-- Rebuilt with the extra clause. Everything else is unchanged from 0002: the
-- customer-create constraints still pin status, status_label, report_ready and
-- an empty review, so a visitor cannot submit a pre-approved claim either.
drop policy if exists cases_insert on public.cases;
create policy cases_insert on public.cases
  for insert
  with check (
    public.is_manager()
    or (
      owner_uid = auth.uid()
      and status = 'submitted'
      and status_label = 'Submitted'
      and report_ready = false
      and coalesce(review ->> 'reviewer_name', '') = ''
      and coalesce(review ->> 'final_action', '') = ''
      and coalesce((review ->> 'reviewed_total_cost_usd')::numeric, 0) = 0
      -- Demo visitors only: a real customer is not capped.
      and (
        not public.is_anonymous_session()
        or public.owner_case_count(auth.uid()) < public.demo_claim_limit()
      )
    )
  );
