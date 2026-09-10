-- Let trusted server-side writers past the column allowlist trigger.
--
-- RLS policies do not apply to the service key -- it holds BYPASSRLS -- but a
-- BEFORE UPDATE trigger fires for every writer regardless. With no user JWT,
-- auth.uid() is null and jwt_role() is empty, so none of the trigger's
-- branches matched and it fell through to
--     raise exception 'cases: update not permitted'
-- which made every administrative write impossible. The demo reviewer could
-- not assign a claim to itself, so POST /api/demo/enroll returned 500.
--
-- This grants nothing new. The service key can already read and write every
-- row by bypassing RLS; the trigger was only stopping it inconsistently.
-- Direct database connections with no claims at all -- migrations, psql --
-- are treated the same way, for the same reason.
--
-- Additive and idempotent.

create or replace function public.is_service_role()
returns boolean
language sql
stable
as $$
  select coalesce(
    current_setting('request.jwt.claims', true)::jsonb ->> 'role',
    ''
  ) = 'service_role';
$$;

-- A request with no JWT claims is not coming through PostgREST at all.
create or replace function public.is_trusted_writer()
returns boolean
language sql
stable
as $$
  select current_setting('request.jwt.claims', true) is null
      or current_setting('request.jwt.claims', true) = ''
      or public.is_service_role();
$$;

revoke all on function public.is_service_role() from anon;
revoke all on function public.is_trusted_writer() from anon;

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
    'last_customer_message_at', 'customer_thread_seen_at',
    'incident_date', 'incident_description'
  ];
  employee_cols  text[] := array[
    'status', 'status_label', 'report_ready', 'updated_at',
    'requested_evidence', 'requested_evidence_types', 'reviewer_request_note',
    'evidence_requested_at', 'evidence_due_at', 'consumer_notifications',
    'review', 'reviewed_total_cost_usd', 'estimate_line_items',
    'estimate_versions', 'final_action', 'reviewer_evidence', 'ai_reasoning',
    'customer_statement', 'claim_context', 'vehicle_type',
    'last_employee_message_at', 'employee_thread_seen_at',
    'priority_score', 'queue_bucket',
    'filename', 'filenames', 'overall_severity', 'repairability', 'summary',
    'total_loss', 'total_loss_reason', 'estimated_total_cost_usd',
    'estimated_vehicle_value_usd', 'valuation_methodology',
    'valuation_comparable_prices_usd', 'regions', 'reviewed_regions',
    'sources', 'search_queries', 'pricing_factors', 'assessment_flags',
    'completeness_checks', 'retry_attempts', 'evaluation', 'meta',
    'recommended_action'
  ];
begin
  -- Trusted server-side writers first: the service key already bypasses RLS,
  -- so the trigger has no business second-guessing it.
  if public.is_trusted_writer() or public.is_manager() then
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
