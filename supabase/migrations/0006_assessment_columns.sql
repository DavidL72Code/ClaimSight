-- The AI assessment payload.
--
-- app.js saves a claim by spreading the whole /api/assess response into the
-- case: `{...assessment, claim_reference, status, ...}`. Firestore accepted
-- that because documents are schemaless. Postgres rejects any key without a
-- column, so a claim submission would have failed on the first unknown field
-- with PGRST204 -- and the pages read most of these back individually
-- (payload.repairability, payload.summary, payload.regions), so folding them
-- into one opaque blob would have meant rewriting every read too.
--
-- Real columns for the scalars the app filters or displays, jsonb for the
-- structures it only ever round-trips whole. Names match AssessmentResponse
-- in app/models/schemas.py so the spread lands without translation.
--
-- Additive and idempotent.

alter table public.cases
  -- assessment scalars
  add column if not exists filename                        text,
  add column if not exists overall_severity                text,
  add column if not exists repairability                   text,
  add column if not exists summary                         text,
  add column if not exists total_loss                      boolean not null default false,
  add column if not exists total_loss_reason               text,
  add column if not exists estimated_vehicle_value_usd     numeric(12, 2) not null default 0,
  add column if not exists valuation_methodology           text,
  -- claim intake, written by the new-claim form
  add column if not exists customer_email                  text,
  add column if not exists incident_date                   text,
  add column if not exists incident_description            text,
  -- structures the app round-trips whole
  add column if not exists filenames                       jsonb not null default '[]'::jsonb,
  add column if not exists regions                         jsonb not null default '[]'::jsonb,
  add column if not exists reviewed_regions                jsonb not null default '[]'::jsonb,
  add column if not exists sources                         jsonb not null default '[]'::jsonb,
  add column if not exists search_queries                  jsonb not null default '[]'::jsonb,
  add column if not exists pricing_factors                 jsonb not null default '[]'::jsonb,
  add column if not exists assessment_flags                jsonb not null default '[]'::jsonb,
  add column if not exists completeness_checks             jsonb not null default '[]'::jsonb,
  add column if not exists valuation_comparable_prices_usd jsonb not null default '[]'::jsonb,
  add column if not exists retry_attempts                  jsonb not null default '[]'::jsonb,
  add column if not exists evaluation                      jsonb,
  add column if not exists meta                            jsonb not null default '{}'::jsonb;

-- incident_date is text rather than date on purpose: it comes straight from a
-- date input that may be empty, and "" is not a valid date. The old Firestore
-- write stored the raw string too.

-- The adjuster's review page rewrites the assessment when it re-runs an
-- evaluation, so these join the employee allowlist. They stay off the
-- customer list: a claimant must not be able to restate the AI's findings on
-- their own claim. Rebuilt in full because the allowlists are array literals.
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
    -- the claimant's own account of the incident, from the edit-claim form
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
    -- re-running an assessment rewrites these
    'filename', 'filenames', 'overall_severity', 'repairability', 'summary',
    'total_loss', 'total_loss_reason', 'estimated_total_cost_usd',
    'estimated_vehicle_value_usd', 'valuation_methodology',
    'valuation_comparable_prices_usd', 'regions', 'reviewed_regions',
    'sources', 'search_queries', 'pricing_factors', 'assessment_flags',
    'completeness_checks', 'retry_attempts', 'evaluation', 'meta',
    'recommended_action'
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
