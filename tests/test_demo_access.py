"""Who may drive the simulated reviewer.

The demo has no second person in it: a visitor arriving from the homepage
signs in anonymously and is the only participant. So the step, status and
reply endpoints accept the case owner as well as an adjuster -- but only on
their own case, and only to ask the reviewer to act, never to dictate what it
decides.

These endpoints sit behind the service key, which bypasses RLS, so no policy
stands behind them. The ownership check is the only thing there.
"""

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.api import routes

OWNER = {"uid": "owner-uid", "email": "", "role": ""}
STRANGER = {"uid": "stranger-uid", "email": "", "role": ""}
ADJUSTER = {"uid": "emp-uid", "email": "dana@claimsight.com", "role": "employee"}

CASE = "DEMO-1"


class StubAuth:
    ready = True

    def __init__(self, token):
        self._token = token

    def verify_bearer_token(self, authorization):
        return self._token if authorization else None


class StubReviewer:
    ready = True

    def __init__(self):
        self.advanced = []
        self.replied = []

    def owns(self, case_id, owner_uid):
        return case_id == CASE and owner_uid == OWNER["uid"]

    def advance(self, case_id):
        self.advanced.append(case_id)
        return {"case_id": case_id, "cursor": 1, "total_steps": 7, "done": False,
                "next_step_title": "Verify", "steps": [], "simulated": True}

    def status(self, case_id):
        return {"case_id": case_id, "cursor": 1, "total_steps": 7, "done": False,
                "next_step_title": "Verify", "steps": [], "simulated": True}

    def reply_to_customer(self, case_id):
        self.replied.append(case_id)
        return {"case_id": case_id, "customer_question": "when?",
                "reply": "Looking at it now.", "simulated": True}


@pytest.fixture
def client_for(monkeypatch):
    def _build(token):
        reviewer = StubReviewer()
        monkeypatch.setattr(routes, "supabase_auth", StubAuth(token))
        monkeypatch.setattr(routes, "demo_reviewer", reviewer)
        monkeypatch.setattr(routes, "DEMO_MODE", True)
        monkeypatch.setattr(routes, "_demo_guard", lambda request: None)
        monkeypatch.setattr(routes, "_enforce_rate_limit", lambda *a, **k: None)
        return TestClient(app), reviewer

    return _build


def _post(client, path, case_id=CASE):
    return client.post(f"/api/demo/{path}", json={"case_id": case_id},
                       headers={"Authorization": "Bearer stub"})


@pytest.mark.parametrize("path", ["review/step", "review/status", "reply"])
def test_owner_may_drive_their_own_demo(client_for, path):
    client, _ = client_for(OWNER)
    assert _post(client, path).status_code == 200


@pytest.mark.parametrize("path", ["review/step", "review/status", "reply"])
def test_adjuster_may_drive_any_demo(client_for, path):
    client, _ = client_for(ADJUSTER)
    assert _post(client, path).status_code == 200


@pytest.mark.parametrize("path", ["review/step", "review/status", "reply"])
def test_a_stranger_gets_404_not_403(client_for, path):
    """404 so this cannot be used to find out which case ids exist."""
    client, reviewer = client_for(STRANGER)
    assert _post(client, path).status_code == 404
    assert reviewer.advanced == []
    assert reviewer.replied == []


@pytest.mark.parametrize("path", ["review/step", "review/status", "reply"])
def test_unauthenticated_is_refused(client_for, path):
    client, _ = client_for(OWNER)
    response = client.post(f"/api/demo/{path}", json={"case_id": CASE})
    assert response.status_code == 401


def test_owner_cannot_drive_someone_elses_case(client_for):
    client, reviewer = client_for(OWNER)
    assert _post(client, "review/step", case_id="SOMEONE-ELSE").status_code == 404
    assert reviewer.advanced == []
