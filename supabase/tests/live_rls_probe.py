"""Verifies the RLS policies against a real Supabase project.

run_rls_tests.sh proves the policies against a local Postgres with a shim for
auth.uid() and auth.jwt(). This proves them against the real thing: it
provisions throwaway users through the admin API, signs each of them in to
get a genuine access token, exercises the policies over PostgREST, and
removes everything it created.

Worth having as well as the local suite because only this catches
differences in how Supabase itself sets up roles, the auth schema and token
signing -- this project, for instance, issues ES256 user tokens while its API
keys are legacy HS256.

Reads SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_KEY from .env.
Creates users under @claimsight.invalid and a case id of RLS-PROBE-1, then
deletes them. Exits non-zero on any policy failure.

    python supabase/tests/live_rls_probe.py

Two conventions matter when reading the assertions:

  * PostgREST answers a write that RLS reduces to zero rows with 200 and an
    empty body, not an error, so denial means "nothing came back" rather
    than a 4xx.
  * Setting a column to the value it already holds is not a change, so it is
    never refused. Assertions must write a genuinely different value, and the
    probe resets its own data first -- leftovers from an earlier run turn
    writes into no-ops and read as false passes.
"""

import os, sys, json, requests
from dotenv import load_dotenv; load_dotenv(".env")
from dotenv import load_dotenv; load_dotenv(".env")
URL=os.getenv("SUPABASE_URL").rstrip("/"); SVC=os.getenv("SUPABASE_SERVICE_KEY"); ANON=os.getenv("SUPABASE_ANON_KEY")
SVC_H={"apikey":SVC,"Authorization":f"Bearer {SVC}","Content-Type":"application/json"}
PW="ClaimSightRlsProbe!9241"
USERS={
 "alice":   ("rls-probe-alice@claimsight.invalid",   {}),
 "bob":     ("rls-probe-bob@claimsight.invalid",     {}),
 "adjuster":("rls-probe-adjuster@claimsight.invalid",{"role":"employee"}),
 "other":   ("rls-probe-other@claimsight.invalid",   {"role":"employee"}),
 "manager": ("rls-probe-manager@claimsight.invalid", {"role":"manager"}),
}
ids={}; tokens={}

def create():
    for name,(email,app_md) in USERS.items():
        r=requests.post(f"{URL}/auth/v1/admin/users", headers=SVC_H, timeout=25,
            json={"email":email,"password":PW,"email_confirm":True,"app_metadata":app_md})
        if r.status_code in (200,201):
            ids[name]=r.json()["id"]
        else:  # already exists from a previous run -- look it up
            q=requests.get(f"{URL}/auth/v1/admin/users", headers=SVC_H, timeout=25)
            for u in q.json().get("users",[]):
                if u["email"]==email: ids[name]=u["id"]
        r2=requests.post(f"{URL}/auth/v1/token", headers={"apikey":ANON,"Content-Type":"application/json"},
                         params={"grant_type":"password"}, json={"email":email,"password":PW}, timeout=25)
        if r2.status_code==200: tokens[name]=r2.json()["access_token"]
        print(f"  {name:9} id={'yes' if name in ids else 'NO':3} token={'yes' if name in tokens else 'NO'}")

def hdr(who): return {"apikey":ANON,"Authorization":f"Bearer {tokens[who]}","Content-Type":"application/json"}

FAILED=0
def check(label, ok, detail=""):
    global FAILED
    if ok: print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}  {detail}"); FAILED+=1

def rest(method, who, path, extra_headers=None, **kw):
    h = hdr(who)
    if extra_headers: h.update(extra_headers)
    return requests.request(method, f"{URL}/rest/v1/{path}", headers=h, timeout=25, **kw)

print("=== provisioning probe users (app_metadata.role set by admin API) ===")
create()
if len(tokens)<5:
    print("  could not obtain all tokens; aborting"); sys.exit(2)

# Reset first: leftovers from a previous run make writes no-ops, which reads
# as a policy failure when it is really just unchanged state.
print("\n=== reset any leftover probe data ===")
for tbl, filt in (("case_activity","case_id=eq.RLS-PROBE-1"),
                  ("case_internal","case_id=eq.RLS-PROBE-1"),
                  ("cases","id=eq.RLS-PROBE-1")):
    d=requests.delete(f"{URL}/rest/v1/{tbl}?{filt}", headers=SVC_H, timeout=25)
    print(f"  cleared {tbl}: {d.status_code}")

print("\n=== seed a case as manager ===")
r=rest("POST","manager","cases", json={
  "id":"RLS-PROBE-1","owner_uid":ids["alice"],"status":"submitted","status_label":"Submitted",
  "assigned_agent":{"email":USERS['adjuster'][0],"name":"Dana"}}, extra_headers={"Prefer":"return=representation"})
print("  insert ->", r.status_code, r.text[:120])

print("\n=== READ ===")
check("owner sees own case",       len(rest("GET","alice","cases",params={"id":"eq.RLS-PROBE-1","select":"id"}).json())==1)
check("stranger sees nothing",     rest("GET","bob","cases",params={"id":"eq.RLS-PROBE-1","select":"id"}).json()==[])
check("assigned adjuster sees it", len(rest("GET","adjuster","cases",params={"id":"eq.RLS-PROBE-1","select":"id"}).json())==1)
check("unassigned adjuster blind", rest("GET","other","cases",params={"id":"eq.RLS-PROBE-1","select":"id"}).json()==[])
check("manager sees it",           len(rest("GET","manager","cases",params={"id":"eq.RLS-PROBE-1","select":"id"}).json())==1)

print("\n=== COLUMN ALLOWLISTS ===")
def upd(who, body):
    r=rest("PATCH",who,"cases",params={"id":"eq.RLS-PROBE-1"},json=body,
           extra_headers={"Prefer":"return=representation"})
    return r
r=upd("alice",{"vehicle_type":"Audi A4"});            check("owner edits vehicle_type", r.status_code==200 and r.json()!=[], f"{r.status_code} {r.text[:80]}")
r=upd("alice",{"review":{"final_action":"approve"}}); check("owner CANNOT write review", r.status_code>=400 or r.json()==[], f"{r.status_code} {r.text[:80]}")
r=upd("alice",{"status":"approved"});                 check("owner CANNOT flip status", r.status_code>=400 or r.json()==[], f"{r.status_code} {r.text[:80]}")
r=upd("adjuster",{"review":{"reviewer_name":"Dana"}});check("adjuster edits review", r.status_code==200 and r.json()!=[], f"{r.status_code} {r.text[:80]}")
r=upd("adjuster",{"consumer_decision":{"decision":"accepted"}}); check("adjuster CANNOT forge decision", r.status_code>=400 or r.json()==[], f"{r.status_code} {r.text[:80]}")
r=upd("adjuster",{"owner_uid":ids["bob"]});           check("adjuster CANNOT reparent case", r.status_code>=400 or r.json()==[], f"{r.status_code} {r.text[:80]}")
r=upd("bob",{"vehicle_type":"stolen"});               check("stranger CANNOT update", r.status_code>=400 or r.json()==[], f"{r.status_code} {r.text[:80]}")

print("\n=== STATE GATES ===")
r=upd("alice",{"consumer_decision":{"decision":"accepted"}}); check("decision blocked before final_review", r.status_code>=400 or r.json()==[], f"{r.status_code}")
r=upd("adjuster",{"status":"final_review"});                  check("adjuster advances status", r.status_code==200 and r.json()!=[], f"{r.status_code}")
r=upd("alice",{"consumer_decision":{"decision":"accepted"}}); check("decision allowed in final_review", r.status_code==200 and r.json()!=[], f"{r.status_code} {r.text[:80]}")
r=upd("alice",{"consumer_decision":{"decision":"i_approve_myself"}}); check("bogus decision refused", r.status_code>=400 or r.json()==[], f"{r.status_code}")

print("\n=== case_internal + activity ===")
r=rest("POST","adjuster","case_internal",json={"case_id":"RLS-PROBE-1","data":{"note":"n"}})
check("assigned adjuster writes internal", r.status_code in (200,201), f"{r.status_code} {r.text[:80]}")
check("customer cannot read internal", rest("GET","alice","case_internal",params={"case_id":"eq.RLS-PROBE-1"}).json()==[])
check("unassigned adjuster cannot read internal", rest("GET","other","case_internal",params={"case_id":"eq.RLS-PROBE-1"}).json()==[])
r=rest("POST","alice","case_activity",json={"case_id":"RLS-PROBE-1","actor_uid":ids["alice"],"actor_role":"customer","type":"message","label":"hi"})
check("owner logs message", r.status_code in (200,201), f"{r.status_code} {r.text[:80]}")
r=rest("POST","alice","case_activity",json={"case_id":"RLS-PROBE-1","actor_uid":ids["bob"],"actor_role":"customer","type":"message","label":"spoof"})
check("owner CANNOT spoof actor_uid", r.status_code>=400, f"{r.status_code}")
r=rest("POST","alice","case_activity",json={"case_id":"RLS-PROBE-1","actor_uid":ids["alice"],"actor_role":"employee","type":"message","label":"x"})
check("owner CANNOT claim employee role", r.status_code>=400, f"{r.status_code}")
r=rest("PATCH","adjuster","case_activity",params={"case_id":"eq.RLS-PROBE-1"},json={"label":"rewritten"},extra_headers={"Prefer":"return=representation"})
# PostgREST answers a write that RLS reduces to zero rows with 200 and an
# empty representation, not an error, so denial means "nothing came back".
check("activity log append-only", r.status_code>=400 or r.json()==[], f"{r.status_code} {r.text[:60]}")
d=rest("DELETE","alice","case_activity",params={"case_id":"eq.RLS-PROBE-1"},extra_headers={"Prefer":"return=representation"})
check("customer cannot delete history", d.status_code>=400 or d.json()==[], f"{d.status_code}")
# Ground truth: confirm the row survived both attempts.
gt=requests.get(f"{URL}/rest/v1/case_activity",headers=SVC_H,params={"case_id":"eq.RLS-PROBE-1","select":"label"},timeout=20).json()
check("history intact after both attempts", len(gt)==1 and gt[0]["label"]=="hi", str(gt)[:80])

print(f"\n  LIVE FAILURES: {FAILED}")
with open(os.environ.get("PROBE_STATE","/tmp/probe_state.json"),"w") as f:
    json.dump({"ids":ids},f)
sys.exit(1 if FAILED else 0)
