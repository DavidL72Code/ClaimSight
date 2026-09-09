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
