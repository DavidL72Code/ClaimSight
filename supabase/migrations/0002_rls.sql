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
