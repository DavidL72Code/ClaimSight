#!/usr/bin/env bash
#
# Exercises the RLS policies in supabase/migrations against a real Postgres.
#
# These policies are the access-control boundary for the whole app, so they
# need a regression suite rather than a one-time read-through. The tests run
# as the `authenticated` role with a JWT claims payload set the same way
# PostgREST sets it, so auth.uid(), auth.jwt() and the role claim behave as
# they do on Supabase.
#
# Usage:  supabase/tests/run_rls_tests.sh [psql-connection-flags]
# Default target is a local server on 127.0.0.1:5433 as user postgres.
#
#   brew install postgresql@16
#   initdb -D /tmp/pgdata -U postgres --auth=trust
#   LC_ALL=en_US.UTF-8 pg_ctl -D /tmp/pgdata -o "-h 127.0.0.1 -p 5433" start
#   supabase/tests/run_rls_tests.sh

set -uo pipefail

PG_FLAGS=${*:--h 127.0.0.1 -p 5433 -U postgres}
DB=claimsight_rls_test
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
FAILED=0

psqlq() { psql $PG_FLAGS -d "$DB" -v ON_ERROR_STOP=1 -q "$@"; }

echo "==> preparing $DB"
psql $PG_FLAGS -d postgres -q -c "drop database if exists $DB;" -c "create database $DB;" || exit 1
psqlq -f "$HERE/supabase_shim.sql"                     || exit 1
psqlq -f "$ROOT/supabase/migrations/0001_schema.sql"   || exit 1
psqlq -f "$ROOT/supabase/migrations/0002_rls.sql"      || exit 1

# Claim payloads. app_metadata.role is where Supabase keeps custom claims.
A='{"sub":"11111111-1111-1111-1111-111111111111","email":"alice@example.com","app_metadata":{}}'
B='{"sub":"22222222-2222-2222-2222-222222222222","email":"bob@example.com","app_metadata":{}}'
ADJ='{"sub":"33333333-3333-3333-3333-333333333333","email":"adjuster@claimsight.com","app_metadata":{"role":"employee"}}'
OTH='{"sub":"44444444-4444-4444-4444-444444444444","email":"other@claimsight.com","app_metadata":{"role":"employee"}}'
MGR='{"sub":"55555555-5555-5555-5555-555555555555","email":"boss@claimsight.com","app_metadata":{"role":"manager"}}'

echo "==> seeding"
psqlq <<SEED
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'adjuster@claimsight.com'),
  ('44444444-4444-4444-4444-444444444444', 'other@claimsight.com'),
  ('55555555-5555-5555-5555-555555555555', 'boss@claimsight.com');
select set_config('request.jwt.claims', '$MGR', false);
set role authenticated;
insert into public.cases (id, owner_uid, status, status_label, assigned_agent)
values ('CLM-1', '11111111-1111-1111-1111-111111111111', 'submitted', 'Submitted',
        '{"email":"adjuster@claimsight.com","name":"Dana"}'::jsonb);
insert into public.case_internal (case_id, data) values ('CLM-1', '{"note":"internal"}');
SEED

# act <label> <claims> <sql> <OK|DENY>
#
# A refused SELECT returns no rows rather than erroring, so read tests divide
# by count(*) to turn "invisible" into a hard error. A refused UPDATE/DELETE
# reports zero affected rows, which is also treated as denial.
act() {
  local label="$1" claims="$2" sql="$3" expect="$4" out rc got
  out=$(psql $PG_FLAGS -d "$DB" -v ON_ERROR_STOP=1 -tA 2>&1 <<EOSQL
set role postgres;
select set_config('request.jwt.claims', '$claims', false);
set role authenticated;
$sql
EOSQL
)
  rc=$?
  if [ $rc -eq 0 ]; then got=OK; else got=DENY; fi
  if echo "$out" | grep -qE '^UPDATE 0$|^DELETE 0$'; then got=DENY; fi
  if [ "$got" = "$expect" ]; then
    printf "  PASS  %-56s %s\n" "$label" "$got"
  else
    printf "  FAIL  %-56s got=%s want=%s\n" "$label" "$got" "$expect"
    echo "$out" | grep -iE 'error|denied|permitted|immutable' | head -1 | sed 's/^/          /'
    FAILED=$((FAILED + 1))
  fi
}

echo "==> read access: ownsCase / isAssignedEmployee / isManager"
act "owner reads own case"                       "$A"   "select id from public.cases where id='CLM-1';" OK
act "stranger cannot read another's case"        "$B"   "select 1/count(*) from public.cases where id='CLM-1';" DENY
act "assigned adjuster reads"                    "$ADJ" "select id from public.cases where id='CLM-1';" OK
act "unassigned adjuster cannot read"            "$OTH" "select 1/count(*) from public.cases where id='CLM-1';" DENY
act "manager reads"                              "$MGR" "select id from public.cases where id='CLM-1';" OK

echo "==> ownership is immutable"
act "stranger cannot update another's case"      "$B"   "update public.cases set vehicle_type='x' where id='CLM-1';" DENY
act "owner cannot hand off owner_uid"            "$A"   "update public.cases set owner_uid='22222222-2222-2222-2222-222222222222' where id='CLM-1';" DENY
act "adjuster cannot reparent a case"            "$ADJ" "update public.cases set owner_uid='22222222-2222-2222-2222-222222222222' where id='CLM-1';" DENY
act "adjuster cannot reassign the case"          "$ADJ" "update public.cases set assigned_agent='{\"email\":\"other@claimsight.com\"}'::jsonb where id='CLM-1';" DENY

echo "==> column allowlists (validCustomerUpdate / validEmployeeUpdate)"
act "owner edits own claim_context"              "$A"   "update public.cases set claim_context='{\"make\":\"Audi\"}'::jsonb where id='CLM-1';" OK
act "owner cannot write the review"              "$A"   "update public.cases set review='{\"final_action\":\"approve\"}'::jsonb where id='CLM-1';" DENY
act "owner cannot set the reviewed cost"         "$A"   "update public.cases set reviewed_total_cost_usd=99999 where id='CLM-1';" DENY
act "owner cannot flip status"                   "$A"   "update public.cases set status='approved' where id='CLM-1';" DENY
act "owner cannot touch adjuster read marker"    "$A"   "update public.cases set employee_thread_seen_at=now() where id='CLM-1';" DENY
act "owner edits own supporting_documents"       "$A"   "update public.cases set supporting_documents='[{\"name\":\"mine.pdf\"}]'::jsonb where id='CLM-1';" OK
act "adjuster edits the review"                  "$ADJ" "update public.cases set review='{\"reviewer_name\":\"Dana\"}'::jsonb where id='CLM-1';" OK
act "adjuster cannot forge consumer_decision"    "$ADJ" "update public.cases set consumer_decision='{\"decision\":\"accepted\"}'::jsonb where id='CLM-1';" DENY
act "adjuster cannot rewrite supporting docs"    "$ADJ" "update public.cases set supporting_documents='[{\"name\":\"forged.pdf\"}]'::jsonb where id='CLM-1';" DENY
act "adjuster cannot write the appeal"           "$ADJ" "update public.cases set appeal='{\"category\":\"x\",\"explanation\":\"y\"}'::jsonb where id='CLM-1';" DENY
act "adjuster cannot touch customer read marker" "$ADJ" "update public.cases set customer_thread_seen_at=now() where id='CLM-1';" DENY

echo "==> decision and appeal state gates"
act "decision refused before final_review"       "$A"   "update public.cases set consumer_decision='{\"decision\":\"accepted\"}'::jsonb where id='CLM-1';" DENY
act "appeal refused before final_review"         "$A"   "update public.cases set appeal='{\"category\":\"c\",\"explanation\":\"e\"}'::jsonb where id='CLM-1';" DENY
act "adjuster advances to final_review"          "$ADJ" "update public.cases set status='final_review' where id='CLM-1';" OK
act "accepted decision now allowed"              "$A"   "update public.cases set consumer_decision='{\"decision\":\"accepted\"}'::jsonb where id='CLM-1';" OK
act "invented decision value refused"            "$A"   "update public.cases set consumer_decision='{\"decision\":\"approved_by_me\"}'::jsonb where id='CLM-1';" DENY
act "incomplete appeal refused"                  "$A"   "update public.cases set appeal='{\"category\":\"c\"}'::jsonb where id='CLM-1';" DENY
act "complete appeal allowed"                    "$A"   "update public.cases set appeal='{\"category\":\"c\",\"explanation\":\"e\"}'::jsonb where id='CLM-1';" OK

echo "==> insert constraints (validCustomerCreate)"
act "customer creates own submitted claim"       "$A" "insert into public.cases (id,owner_uid,status,status_label) values ('CLM-2','11111111-1111-1111-1111-111111111111','submitted','Submitted');" OK
act "cannot create a pre-approved claim"         "$A" "insert into public.cases (id,owner_uid,status,status_label) values ('CLM-3','11111111-1111-1111-1111-111111111111','approved','Approved');" DENY
act "cannot create a report_ready claim"         "$A" "insert into public.cases (id,owner_uid,status,status_label,report_ready) values ('CLM-4','11111111-1111-1111-1111-111111111111','submitted','Submitted',true);" DENY
act "cannot prefill the review"                  "$A" "insert into public.cases (id,owner_uid,status,status_label,review) values ('CLM-5','11111111-1111-1111-1111-111111111111','submitted','Submitted','{\"final_action\":\"approve\"}'::jsonb);" DENY
act "cannot create a claim owned by someone else" "$A" "insert into public.cases (id,owner_uid,status,status_label) values ('CLM-6','22222222-2222-2222-2222-222222222222','submitted','Submitted');" DENY

echo "==> case_internal is adjuster-only"
act "assigned adjuster reads internal notes"     "$ADJ" "select case_id from public.case_internal where case_id='CLM-1';" OK
act "customer cannot read internal notes"        "$A"   "select 1/count(*) from public.case_internal where case_id='CLM-1';" DENY
act "unassigned adjuster cannot read them"       "$OTH" "select 1/count(*) from public.case_internal where case_id='CLM-1';" DENY
act "manager reads internal notes"               "$MGR" "select case_id from public.case_internal where case_id='CLM-1';" OK

echo "==> case_activity is append-only and attributable"
act "owner logs a message event"                 "$A"   "insert into public.case_activity (case_id,actor_uid,actor_role,type,label) values ('CLM-1','11111111-1111-1111-1111-111111111111','customer','message','hi');" OK
act "owner cannot spoof actor_uid"               "$A"   "insert into public.case_activity (case_id,actor_uid,actor_role,type,label) values ('CLM-1','22222222-2222-2222-2222-222222222222','customer','message','hi');" DENY
act "owner cannot claim the employee role"       "$A"   "insert into public.case_activity (case_id,actor_uid,actor_role,type,label) values ('CLM-1','11111111-1111-1111-1111-111111111111','employee','message','hi');" DENY
act "owner cannot use an off-list event type"    "$A"   "insert into public.case_activity (case_id,actor_uid,actor_role,type,label) values ('CLM-1','11111111-1111-1111-1111-111111111111','customer','case_approved','hi');" DENY
act "stranger cannot log on another's case"      "$B"   "insert into public.case_activity (case_id,actor_uid,actor_role,type,label) values ('CLM-1','22222222-2222-2222-2222-222222222222','customer','message','hi');" DENY
act "label longer than 2000 chars refused"       "$A"   "insert into public.case_activity (case_id,actor_uid,actor_role,type,label) values ('CLM-1','11111111-1111-1111-1111-111111111111','customer','message',repeat('x',2001));" DENY
act "history cannot be rewritten"                "$ADJ" "update public.case_activity set label='rewritten' where case_id='CLM-1';" DENY
act "customer cannot delete history"             "$A"   "delete from public.case_activity where case_id='CLM-1';" DENY
act "manager can delete history"                 "$MGR" "delete from public.case_activity where case_id='CLM-1';" OK

echo
if [ "$FAILED" -eq 0 ]; then
  echo "All RLS tests passed."
else
  echo "$FAILED RLS test(s) FAILED."
fi
exit "$FAILED"
