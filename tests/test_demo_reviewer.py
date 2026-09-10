"""Walks the simulated reviewer with a stubbed data layer.

The demo reviewer had no coverage, and the Firebase-to-Supabase conversion
left three faults in it that only appeared when the endpoint was called for
real: two call sites still unpacked _load() as a (ref, data) tuple, and the
activity payload carried actor_email and simulated, which are review_steps
fields rather than case_activity columns.

The stub therefore mimics the two things the real database enforces: rows are
plain dicts, and case_activity rejects any key it has no column for.
"""

import pytest

from app.services.demo_reviewer import DemoReviewer, DemoReviewerError

# Exactly the columns case_activity has, so an extra key fails here too.
ACTIVITY_COLUMNS = {
    "id", "case_id", "actor_uid", "actor_role", "actor_name",
    "type", "label", "created_at", "attachments",
}


class StubAdmin:
    ready = True

    def __init__(self, case):
        self.cases = {case["id"]: dict(case)}
        self.activity = []

    def get_case(self, case_id):
        row = self.cases.get(case_id)
        return dict(row) if row else None

    def update_case(self, case_id, patch):
        if case_id not in self.cases:
            return None
        self.cases[case_id].update(patch)
        return dict(self.cases[case_id])

    def add_activity(self, event):
        unknown = set(event) - ACTIVITY_COLUMNS
        if unknown:
            raise RuntimeError(
                f"case_activity has no column(s): {sorted(unknown)}"
            )
        self.activity.append(dict(event))
        return dict(event)

    def list_activity(self, case_id, limit=200):
        return [e for e in self.activity if e["case_id"] == case_id]


class StubNarrator:
    """Stands in for Gemini. The reviewer must not need it to make progress."""

    enabled = False

    def generate(self, *a, **k):
        raise RuntimeError("narrator should not be required")


def _case():
    return {
        "id": "DEMO-1",
        "owner_uid": "11111111-1111-1111-1111-111111111111",
        "status": "submitted",
        "status_label": "Submitted",
        "vehicle_type": "2019 Audi A4",
        "estimated_total_cost_usd": 2400,
        "estimated_vehicle_value_usd": 21000,
        "regions": [{"panel": "rear bumper", "severity": "moderate", "confidence": 0.82,
                     "estimated_cost_usd": 2400}],
        "assessment_flags": [],
        "completeness_checks": [],
        "review": {},
        "consumer_notifications": [],
        "review_steps": [],
        "demo_review_cursor": None,
        "demo_review_state": {},
    }


@pytest.fixture
def reviewer():
    admin = StubAdmin(_case())
    return DemoReviewer(narrator=StubNarrator(), admin=admin), admin


def test_enroll_assigns_the_demo_reviewer(reviewer):
    r, admin = reviewer
    out = r.enroll(case_id="DEMO-1", owner_uid="11111111-1111-1111-1111-111111111111")
    assert out["cursor"] == 0
    assert out["total_steps"] > 0
    assert admin.cases["DEMO-1"]["assigned_agent"]["simulated"] is True


def test_enroll_refuses_a_case_the_caller_does_not_own(reviewer):
    r, _ = reviewer
    with pytest.raises(DemoReviewerError):
        r.enroll(case_id="DEMO-1", owner_uid="22222222-2222-2222-2222-222222222222")


def test_the_whole_review_runs_to_completion(reviewer):
    """This is what caught the tuple-unpacking faults: step two raised
    'too many values to unpack' the moment it reloaded the case."""
    r, admin = reviewer
    r.enroll(case_id="DEMO-1", owner_uid="11111111-1111-1111-1111-111111111111")

    seen = []
    for _ in range(20):
        out = r.advance(case_id="DEMO-1")
        seen.append(out["cursor"])
        if out["done"]:
            break
    else:
        pytest.fail("the review never reported done")

    assert len(seen) == len(set(seen)), "the cursor must advance every step"
    assert len(admin.cases["DEMO-1"]["review_steps"]) == len(seen)


def test_every_step_is_recorded_in_the_activity_log(reviewer):
    r, admin = reviewer
    r.enroll(case_id="DEMO-1", owner_uid="11111111-1111-1111-1111-111111111111")
    for _ in range(20):
        if r.advance(case_id="DEMO-1")["done"]:
            break
    assert admin.activity, "the review left no trace in claim history"
    # The stub rejects unknown keys, so reaching here proves the payload only
    # uses real columns.
    assert all(set(e) <= ACTIVITY_COLUMNS for e in admin.activity)


def test_advance_refuses_a_case_that_was_never_enrolled(reviewer):
    r, _ = reviewer
    with pytest.raises(DemoReviewerError):
        r.advance(case_id="DEMO-1")


def test_advance_refuses_once_the_review_is_complete(reviewer):
    r, _ = reviewer
    r.enroll(case_id="DEMO-1", owner_uid="11111111-1111-1111-1111-111111111111")
    for _ in range(20):
        if r.advance(case_id="DEMO-1")["done"]:
            break
    with pytest.raises(DemoReviewerError):
        r.advance(case_id="DEMO-1")
