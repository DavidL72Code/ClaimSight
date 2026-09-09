-- ClaimSight: full schema + access control for Supabase.
-- Paste into Supabase Dashboard -> SQL Editor -> Run. Safe to re-run.
-- Generated from the numbered migrations in this directory.

-- ClaimSight schema: the Firestore collections `cases`, `case_activity` and
-- `case_internal` as Postgres tables.
--
-- Shape notes:
--   * Scalars the queries and policies touch are real columns, so they can be
--     indexed and referenced from RLS. Nested objects the app treats as opaque
--     blobs stay jsonb, which keeps the frontend's document shape intact and
--     avoids rewriting call sites for fields nothing filters on.
--   * assigned_agent_email is generated from assigned_agent so policies can
--     compare it without digging through jsonb on every row.
--   * Ids stay text rather than uuid: existing claim references look like
--     CLM-1048 and the frontend passes them around as strings.

create extension if not exists pgcrypto;

create table if not exists public.cases (
  id                        text primary key default gen_random_uuid()::text,
  owner_uid                 uuid not null references auth.users (id) on delete cascade,

  -- triage and workflow state
  status                    text not null default 'submitted',
  status_label              text not null default 'Submitted',
  report_ready              boolean not null default false,
  claim_reference           text,

  -- assignment. The email is what the policies compare, mirroring
  -- assigned_agent.email in the Firestore rules.
  assigned_agent            jsonb not null default '{}'::jsonb,
  assigned_agent_email      text generated always as
                              (lower(nullif(assigned_agent ->> 'email', ''))) stored,

  -- vehicle and claim detail
  vehicle_type              text,
  claim_context             jsonb not null default '{}'::jsonb,
  customer_statement        text,

  -- assessment output
  estimated_total_cost_usd  numeric(12, 2) not null default 0,
  recommended_action        text,
  ai_reasoning              jsonb not null default '[]'::jsonb,

  -- adjuster review
  review                    jsonb not null default '{}'::jsonb,
  reviewed_total_cost_usd   numeric(12, 2) not null default 0,
  estimate_line_items       jsonb not null default '[]'::jsonb,
  estimate_versions         jsonb not null default '[]'::jsonb,
  final_action              text,
  reviewer_evidence         jsonb not null default '[]'::jsonb,
  reviewer_request_note     text,

  -- evidence requests back to the customer
  requested_evidence        jsonb not null default '[]'::jsonb,
  requested_evidence_types  jsonb not null default '[]'::jsonb,
  evidence_requested_at     timestamptz,
  evidence_due_at           timestamptz,
  consumer_notifications    jsonb not null default '[]'::jsonb,

  -- customer-owned fields
  supporting_documents      jsonb not null default '[]'::jsonb,
  consumer_decision         jsonb not null default '{}'::jsonb,
  appeal                    jsonb not null default '{}'::jsonb,

  -- message thread bookkeeping. Each side may only touch its own two, which
  -- the update trigger enforces.
  last_customer_message_at  timestamptz,
  customer_thread_seen_at   timestamptz,
  last_employee_message_at  timestamptz,
  employee_thread_seen_at   timestamptz,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

-- Mirrors the Firestore queries: owner_uid equality ordered by updated_at,
-- and the adjuster queue by assignment.
create index if not exists cases_owner_updated_idx
  on public.cases (owner_uid, updated_at desc);
create index if not exists cases_assigned_updated_idx
  on public.cases (assigned_agent_email, updated_at desc);
create index if not exists cases_status_idx on public.cases (status);

create table if not exists public.case_activity (
  id          uuid primary key default gen_random_uuid(),
  case_id     text not null references public.cases (id) on delete cascade,
  actor_uid   uuid references auth.users (id) on delete set null,
  actor_role  text not null,
  actor_name  text,
  type        text not null,
  -- The Firestore rule capped customer labels at 2000 characters; the column
  -- makes that true for every writer rather than only the checked path.
  label       text not null check (char_length(label) <= 2000),
  created_at  timestamptz not null default now()
);

create index if not exists case_activity_case_created_idx
  on public.case_activity (case_id, created_at desc);
create index if not exists case_activity_type_idx on public.case_activity (type);

-- Adjuster-only working notes. One row per case, never visible to customers.
create table if not exists public.case_internal (
  case_id     text primary key references public.cases (id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- Keep updated_at honest without trusting the client to send it.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists cases_touch_updated_at on public.cases;
create trigger cases_touch_updated_at
  before update on public.cases
  for each row execute function public.touch_updated_at();

drop trigger if exists case_internal_touch_updated_at on public.case_internal;
create trigger case_internal_touch_updated_at
  before update on public.case_internal
  for each row execute function public.touch_updated_at();

-- Access control, ported from firebase/firestore.rules.
--
-- The point of this file is that Postgres enforces these rules, not the
-- application. A bug in the API cannot read around them, the same property
-- Firestore Security Rules gave us.
--
-- One structural difference is worth stating plainly. Firestore expressed
-- field-level limits with
--     request.resource.data.diff(resource.data).affectedKeys().hasOnly([...])
-- which is a per-row, per-actor rule about *which columns changed*. RLS
-- policies are row-level and column GRANTs are role-wide, so neither can say
-- "the owner may change these ten columns but the adjuster may change those
-- twenty-four." That check lives in a BEFORE UPDATE trigger below, which is
-- still inside the database and still cannot be bypassed by the API.

alter table public.cases         enable row level security;
alter table public.case_activity enable row level security;
alter table public.case_internal enable row level security;

-- Force the policies to apply to the table owner too, so a mistake in a
-- migration or a service-role query cannot silently skip them.
alter table public.cases         force row level security;
alter table public.case_activity force row level security;
alter table public.case_internal force row level security;

-- ---------------------------------------------------------------------------
-- Identity helpers. Firestore read request.auth.token.role; the Supabase
-- equivalent is the role claim carried in the JWT's app_metadata.
-- ---------------------------------------------------------------------------

create or replace function public.jwt_role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'role', ''),
    ''
  );
$$;

create or replace function public.jwt_email()
returns text
language sql
stable
as $$
  select lower(coalesce(
    nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'email', ''),
    ''
  ));
$$;

-- isEmployee(): role == "employee" exactly. Managers are handled separately,
-- matching the rules -- isEmployee() there was not true for a manager.
create or replace function public.is_employee()
returns boolean language sql stable as $$
  select public.jwt_role() = 'employee';
$$;

-- isManager(): role in ("manager", "admin").
create or replace function public.is_manager()
returns boolean language sql stable as $$
  select public.jwt_role() in ('manager', 'admin');
$$;

-- isAssignedToCase(caseId) / ownsCaseId(caseId), used by the child tables.
-- SECURITY DEFINER so the lookup itself is not filtered by cases' own
-- policies, which would otherwise recurse.
create or replace function public.is_assigned_to_case(target_case_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_employee()
     and exists (
       select 1 from public.cases c
        where c.id = target_case_id
          and c.assigned_agent_email is not null
          and c.assigned_agent_email = public.jwt_email()
     );
$$;

create or replace function public.owns_case_id(target_case_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.cases c
     where c.id = target_case_id
       and c.owner_uid = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- cases
-- ---------------------------------------------------------------------------

-- allow read: if ownsCase() || isAssignedEmployee() || isManager();
drop policy if exists cases_select on public.cases;
create policy cases_select on public.cases
  for select
  using (
    owner_uid = auth.uid()
    or (public.is_employee() and assigned_agent_email = public.jwt_email())
    or public.is_manager()
  );

-- allow create: if validCustomerCreate() || isManager();
-- validCustomerCreate() also pinned the review sub-object to empty, so a
-- customer cannot submit a claim that arrives pre-approved.
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
    )
  );

-- allow update: if validCustomerUpdate() || validEmployeeUpdate() || isManager();
-- Row-level eligibility here; the column allowlists are in the trigger.
drop policy if exists cases_update on public.cases;
create policy cases_update on public.cases
  for update
  using (
    owner_uid = auth.uid()
    or (public.is_employee() and assigned_agent_email = public.jwt_email())
    or public.is_manager()
  )
  with check (
    owner_uid = auth.uid()
    or (public.is_employee() and assigned_agent_email = public.jwt_email())
    or public.is_manager()
  );

-- allow delete: if isManager();
drop policy if exists cases_delete on public.cases;
create policy cases_delete on public.cases
  for delete using (public.is_manager());

-- ---------------------------------------------------------------------------
-- The column allowlists, ported from validCustomerUpdate() and
-- validEmployeeUpdate(). A customer must not be able to write the adjuster's
-- review, and an adjuster must not be able to forge the customer's
-- acceptance -- which is exactly what the original comment in the rules file
-- said this list was for.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_case_update_allowlist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  changed        text[];
  allowed        text[];
  customer_cols  text[] := array[
    'claim_context', 'vehicle_type', 'supporting_documents',
    'consumer_decision', 'appeal', 'updated_at',
    'last_customer_message_at', 'customer_thread_seen_at'
  ];
  employee_cols  text[] := array[
    'status', 'status_label', 'report_ready', 'updated_at',
    'requested_evidence', 'requested_evidence_types', 'reviewer_request_note',
    'evidence_requested_at', 'evidence_due_at', 'consumer_notifications',
    'review', 'reviewed_total_cost_usd', 'estimate_line_items',
    'estimate_versions', 'final_action', 'reviewer_evidence', 'ai_reasoning',
    'customer_statement', 'claim_context', 'vehicle_type',
    'last_employee_message_at', 'employee_thread_seen_at'
  ];
begin
  -- A manager may change anything, as in the rules.
  if public.is_manager() then
    return new;
  end if;

  select array_agg(key order by key) into changed
    from jsonb_object_keys(to_jsonb(new)) as t(key)
   where to_jsonb(new) -> key is distinct from to_jsonb(old) -> key;

  if changed is null then
    return new;
  end if;

  if old.owner_uid = auth.uid() then
    allowed := customer_cols;

    -- request.resource.data.owner_uid == resource.data.owner_uid
    if new.owner_uid is distinct from old.owner_uid then
      raise exception 'cases: owner_uid is immutable';
    end if;

    -- validCustomerDecision(): a decision may only be set from final_review,
    -- and only to accepted or appealed.
    if new.consumer_decision is distinct from old.consumer_decision then
      if old.status <> 'final_review'
         or coalesce(new.consumer_decision ->> 'decision', '')
              not in ('accepted', 'appealed') then
        raise exception 'cases: consumer_decision is not permitted in status %', old.status;
      end if;
    end if;

    -- validCustomerAppeal(): appeals need final_review and both text fields.
    if new.appeal is distinct from old.appeal then
      if old.status <> 'final_review'
         or coalesce(new.appeal ->> 'explanation', '') = ''
         or coalesce(new.appeal ->> 'category', '') = '' then
        raise exception 'cases: appeal is not permitted or is incomplete';
      end if;
    end if;

  elsif public.is_employee() and old.assigned_agent_email = public.jwt_email() then
    allowed := employee_cols;

    -- request.resource.data.assigned_agent == resource.data.assigned_agent
    -- and owner_uid unchanged: an adjuster may not reassign or reparent a case.
    if new.assigned_agent is distinct from old.assigned_agent then
      raise exception 'cases: assigned_agent is immutable for the assigned adjuster';
    end if;
    if new.owner_uid is distinct from old.owner_uid then
      raise exception 'cases: owner_uid is immutable';
    end if;

  else
    -- The RLS policy should already have refused this row.
    raise exception 'cases: update not permitted';
  end if;

  -- assigned_agent_email is generated from assigned_agent, so it moves on its
  -- own and must not count as an unauthorised change.
  changed := array_remove(changed, 'assigned_agent_email');

  if not (changed <@ allowed) then
    raise exception 'cases: columns % may not be changed by this role',
      array_to_string(array(select unnest(changed) except select unnest(allowed)), ', ');
  end if;

  return new;
end;
$$;

drop trigger if exists cases_enforce_allowlist on public.cases;
-- Runs after touch_updated_at (alphabetical order: cases_enforce_allowlist
-- sorts before cases_touch_updated_at, so updated_at is compared as the
-- client sent it) -- both are allowlisted anyway.
create trigger cases_enforce_allowlist
  before update on public.cases
  for each row execute function public.enforce_case_update_allowlist();

-- ---------------------------------------------------------------------------
-- case_internal: read, write if isAssignedToCase(caseId) || isManager();
-- ---------------------------------------------------------------------------

drop policy if exists case_internal_all on public.case_internal;
create policy case_internal_all on public.case_internal
  for all
  using (public.is_assigned_to_case(case_id) or public.is_manager())
  with check (public.is_assigned_to_case(case_id) or public.is_manager());

-- ---------------------------------------------------------------------------
-- case_activity
-- ---------------------------------------------------------------------------

drop policy if exists case_activity_select on public.case_activity;
create policy case_activity_select on public.case_activity
  for select
  using (
    public.owns_case_id(case_id)
    or public.is_assigned_to_case(case_id)
    or public.is_manager()
  );

-- The customer branch is deliberately narrow: they may only file events on
-- their own case, only as themselves, only as a customer, and only from the
-- five event types the consumer pages actually emit.
drop policy if exists case_activity_insert on public.case_activity;
create policy case_activity_insert on public.case_activity
  for insert
  with check (
    public.is_manager()
    or public.is_assigned_to_case(case_id)
    or (
      public.owns_case_id(case_id)
      and actor_uid = auth.uid()
      and actor_role = 'customer'
      and type in (
        'claim_submitted', 'appeal_submitted', 'decision_accepted',
        'evidence_added', 'message'
      )
    )
  );

-- allow update: if false; -- the activity log is append-only.
-- With no UPDATE policy, RLS refuses every update.

drop policy if exists case_activity_delete on public.case_activity;
create policy case_activity_delete on public.case_activity
  for delete using (public.is_manager());

-- ---------------------------------------------------------------------------
-- Privileges.
--
-- RLS narrows what a role can reach, but it cannot grant access on its own:
-- without these, every query fails with "permission denied for table" before
-- a policy is ever consulted. Supabase's default privileges usually cover
-- tables created through its dashboard; granting explicitly means this
-- migration works the same way applied by hand, by CI, or on a fresh project.
--
-- anon gets nothing: every path in this app requires a signed-in user.
-- ---------------------------------------------------------------------------

grant usage on schema public to authenticated;

grant select, insert, update, delete on public.cases         to authenticated;
grant select, insert,         delete on public.case_activity to authenticated;
grant select, insert, update, delete on public.case_internal to authenticated;

-- No UPDATE on case_activity, matching "allow update: if false" in the rules.
-- The absent privilege makes it impossible rather than merely unpolicied.

revoke all on public.cases         from anon;
revoke all on public.case_activity from anon;
revoke all on public.case_internal from anon;

-- Triage columns for the adjuster queue.
--
-- The frontend has always read payload.queue.priority_score and
-- payload.queue.bucket, but nothing ever wrote them: the backend computes
-- both in case_repository.py and stores them in its own SQLite table as flat
-- columns, never into the case document. Firestore's orderBy also drops
-- documents that lack the ordered field, so the two queue views ordering by
-- queue.priority_score returned an empty list every time.
--
-- These are real columns so the ordering works and can be indexed, named to
-- match what the backend already produces.
--
-- Additive and idempotent: 0001 and 0002 are already applied.

alter table public.cases
  add column if not exists priority_score integer not null default 0,
  add column if not exists queue_bucket   text    not null default 'routine';

create index if not exists cases_queue_idx
  on public.cases (queue_bucket, priority_score desc);

-- Triage is the adjuster's job, so add them to the employee allowlist. The
-- customer list is untouched: a claimant must not be able to raise their own
-- priority. Rebuilt rather than patched because the array is a literal.
create or replace function public.enforce_case_update_allowlist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  changed        text[];
  allowed        text[];
  customer_cols  text[] := array[
    'claim_context', 'vehicle_type', 'supporting_documents',
    'consumer_decision', 'appeal', 'updated_at',
    'last_customer_message_at', 'customer_thread_seen_at'
  ];
  employee_cols  text[] := array[
    'status', 'status_label', 'report_ready', 'updated_at',
    'requested_evidence', 'requested_evidence_types', 'reviewer_request_note',
    'evidence_requested_at', 'evidence_due_at', 'consumer_notifications',
    'review', 'reviewed_total_cost_usd', 'estimate_line_items',
    'estimate_versions', 'final_action', 'reviewer_evidence', 'ai_reasoning',
    'customer_statement', 'claim_context', 'vehicle_type',
    'last_employee_message_at', 'employee_thread_seen_at',
    'priority_score', 'queue_bucket'
  ];
begin
  if public.is_manager() then
    return new;
  end if;

  select array_agg(key order by key) into changed
    from jsonb_object_keys(to_jsonb(new)) as t(key)
   where to_jsonb(new) -> key is distinct from to_jsonb(old) -> key;

  if changed is null then
    return new;
  end if;

  if old.owner_uid = auth.uid() then
    allowed := customer_cols;

    if new.owner_uid is distinct from old.owner_uid then
      raise exception 'cases: owner_uid is immutable';
    end if;

    if new.consumer_decision is distinct from old.consumer_decision then
      if old.status <> 'final_review'
         or coalesce(new.consumer_decision ->> 'decision', '')
              not in ('accepted', 'appealed') then
        raise exception 'cases: consumer_decision is not permitted in status %', old.status;
      end if;
    end if;

    if new.appeal is distinct from old.appeal then
      if old.status <> 'final_review'
         or coalesce(new.appeal ->> 'explanation', '') = ''
         or coalesce(new.appeal ->> 'category', '') = '' then
        raise exception 'cases: appeal is not permitted or is incomplete';
      end if;
    end if;

  elsif public.is_employee() and old.assigned_agent_email = public.jwt_email() then
    allowed := employee_cols;

    if new.assigned_agent is distinct from old.assigned_agent then
      raise exception 'cases: assigned_agent is immutable for the assigned adjuster';
    end if;
    if new.owner_uid is distinct from old.owner_uid then
      raise exception 'cases: owner_uid is immutable';
    end if;

  else
    raise exception 'cases: update not permitted';
  end if;

  changed := array_remove(changed, 'assigned_agent_email');

  if not (changed <@ allowed) then
    raise exception 'cases: columns % may not be changed by this role',
      array_to_string(array(select unnest(changed) except select unnest(allowed)), ', ');
  end if;

  return new;
end;
$$;

-- Attachments on activity events.
--
-- Both message composers write an attachments array alongside the message --
-- [{name, download_url}] returned by POST /api/attachments -- and the
-- renderers read it back to draw the file chips. The column was missed when
-- the Firestore documents were mapped to tables, so every message send failed
-- with PGRST204 "could not find the 'attachments' column".
--
-- jsonb rather than a child table: the app only ever reads the whole array
-- back with its event and never queries inside it.
--
-- Additive and idempotent.

alter table public.case_activity
  add column if not exists attachments jsonb not null default '[]'::jsonb;

-- Enable change delivery for the tables the UI watches.
--
-- Supabase does not put new tables into the supabase_realtime publication, so
-- postgres_changes subscriptions attach and report "joined" but never receive
-- anything. That is silent: the watchers still do their initial read, so a
-- page looks like it works and simply stops updating -- exactly what
-- onSnapshot used to do for free.
--
-- REPLICA IDENTITY FULL matters as much as the publication. Realtime applies
-- RLS to each change before delivering it, and for UPDATE and DELETE it needs
-- the old row to make that decision. With the default identity only the
-- primary key is published, so the policy check cannot run and the event is
-- dropped -- which would have broken every case-status update while message
-- inserts kept working.
--
-- Guarded so this file also applies to a plain Postgres, where the Supabase
-- publication does not exist, and so re-running it is safe.

alter table public.cases         replica identity full;
alter table public.case_activity replica identity full;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    -- Local Postgres: nothing subscribes, so there is nothing to publish to.
    raise notice 'supabase_realtime publication not present; skipping';
    return;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public' and tablename = 'cases'
  ) then
    alter publication supabase_realtime add table public.cases;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public' and tablename = 'case_activity'
  ) then
    alter publication supabase_realtime add table public.case_activity;
  end if;
end
$$;
