"""Tests for /api/keepalive, the endpoint an uptime monitor polls.

It is unauthenticated and makes an outbound request, so the caching floor
matters as much as the happy path: without it, anyone hitting this route in
a loop would hammer Supabase through us.
"""

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.api import routes


class StubStorage:
    def __init__(self, result, ready=True):
        self.result = result
        self.ready = ready
        self.calls = 0

    def ping(self):
        self.calls += 1
        return self.result


@pytest.fixture(autouse=True)
def clear_state(monkeypatch):
    routes._keepalive_cache.clear()
    monkeypatch.setattr(routes, "_enforce_rate_limit", lambda *a, **k: None)
    yield
    routes._keepalive_cache.clear()


def test_reports_ok_when_supabase_is_reachable(monkeypatch):
    monkeypatch.setattr(routes, "attachment_storage", StubStorage((True, "reachable")))
    body = TestClient(app).get("/api/keepalive").json()
    assert body["status"] == "ok"
    assert body["supabase"] == "reachable"


def test_returns_503_when_configured_but_unreachable(monkeypatch):
    monkeypatch.setattr(routes, "attachment_storage", StubStorage((False, "unreachable")))
    response = TestClient(app).get("/api/keepalive")
    # A monitor should page on this: the project is probably paused.
    assert response.status_code == 503


def test_unconfigured_storage_is_not_an_outage(monkeypatch):
    # No credentials yet is a deliberate state, not something to alert on,
    # otherwise the monitor pages continuously during setup.
    monkeypatch.setattr(routes, "attachment_storage", StubStorage((False, "not_configured")))
    response = TestClient(app).get("/api/keepalive")
    assert response.status_code == 200
    assert response.json()["supabase"] == "not_configured"


def test_supabase_is_touched_at_most_once_per_interval(monkeypatch):
    stub = StubStorage((True, "reachable"))
    monkeypatch.setattr(routes, "attachment_storage", stub)
    client = TestClient(app)

    first = client.get("/api/keepalive").json()
    assert first["cache"] == "miss"

    # Twenty more polls in the same window must not become twenty more
    # outbound requests.
    for _ in range(20):
        assert client.get("/api/keepalive").json()["cache"] == "hit"
    assert stub.calls == 1


def test_cache_expires_so_a_paused_project_is_noticed(monkeypatch):
    stub = StubStorage((True, "reachable"))
    monkeypatch.setattr(routes, "attachment_storage", stub)
    client = TestClient(app)
    client.get("/api/keepalive")
    assert stub.calls == 1

    # Age the cached entry past the floor.
    routes._keepalive_cache["checked_at"] -= routes.KEEPALIVE_MIN_INTERVAL_SECONDS + 1
    assert client.get("/api/keepalive").json()["cache"] == "miss"
    assert stub.calls == 2


def test_keepalive_needs_no_authentication(monkeypatch):
    # An uptime monitor cannot hold a Firebase ID token.
    monkeypatch.setattr(routes, "attachment_storage", StubStorage((True, "reachable")))
    assert TestClient(app).get("/api/keepalive").status_code == 200


def test_rate_limit_is_applied(monkeypatch):
    calls = []
    monkeypatch.setattr(routes, "attachment_storage", StubStorage((True, "reachable")))
    monkeypatch.setattr(routes, "_enforce_rate_limit", lambda *a, **k: calls.append(1))
    TestClient(app).get("/api/keepalive")
    assert calls, "keepalive must go through the rate limiter"


# --- demo cleanup ---------------------------------------------------------


class StubAdmin:
    def __init__(self, deleted=0, fail=False):
        self.deleted = deleted
        self.fail = fail
        self.calls = []

    def prune_anonymous_users(self, older_than_hours=24, limit=200):
        self.calls.append(older_than_hours)
        if self.fail:
            from app.services.supabase_data import SupabaseDataError

            raise SupabaseDataError("listing refused")
        return {"deleted": self.deleted, "examined": 5, "older_than_hours": older_than_hours}


@pytest.fixture(autouse=True)
def _clear_prune_cache():
    routes._demo_prune_cache.clear()
    yield
    routes._demo_prune_cache.clear()


def test_prune_runs_with_the_keepalive(monkeypatch):
    admin = StubAdmin(deleted=3)
    monkeypatch.setattr(routes, "attachment_storage", StubStorage((True, "reachable")))
    monkeypatch.setattr(routes, "supabase_admin", admin)
    body = TestClient(app).get("/api/keepalive").json()
    assert body["demo_pruned"] == 3
    assert admin.calls == [routes.DEMO_USER_TTL_HOURS]


def test_prune_is_at_most_hourly(monkeypatch):
    """The monitor polls every five minutes; the prune must not."""
    admin = StubAdmin()
    monkeypatch.setattr(routes, "attachment_storage", StubStorage((True, "reachable")))
    monkeypatch.setattr(routes, "supabase_admin", admin)
    client = TestClient(app)
    client.get("/api/keepalive")
    for _ in range(12):
        routes._keepalive_cache.clear()  # force the reachability check to re-run
        client.get("/api/keepalive")
    assert len(admin.calls) == 1


def test_prune_resumes_after_the_hour(monkeypatch):
    admin = StubAdmin()
    monkeypatch.setattr(routes, "attachment_storage", StubStorage((True, "reachable")))
    monkeypatch.setattr(routes, "supabase_admin", admin)
    client = TestClient(app)
    client.get("/api/keepalive")
    routes._demo_prune_cache["at"] -= routes.DEMO_PRUNE_MIN_INTERVAL_SECONDS + 1
    routes._keepalive_cache.clear()
    client.get("/api/keepalive")
    assert len(admin.calls) == 2


def test_prune_failure_does_not_page_the_monitor(monkeypatch):
    """Cleanup is housekeeping: if it fails the endpoint must still be 200."""
    monkeypatch.setattr(routes, "attachment_storage", StubStorage((True, "reachable")))
    monkeypatch.setattr(routes, "supabase_admin", StubAdmin(fail=True))
    response = TestClient(app).get("/api/keepalive")
    assert response.status_code == 200
    assert response.json()["demo_pruned"] == "skipped"


def test_no_prune_when_supabase_is_unreachable(monkeypatch):
    admin = StubAdmin()
    monkeypatch.setattr(routes, "attachment_storage", StubStorage((False, "unreachable")))
    monkeypatch.setattr(routes, "supabase_admin", admin)
    TestClient(app).get("/api/keepalive")
    assert admin.calls == []


def test_ttl_of_zero_disables_pruning(monkeypatch):
    admin = StubAdmin()
    monkeypatch.setattr(routes, "attachment_storage", StubStorage((True, "reachable")))
    monkeypatch.setattr(routes, "supabase_admin", admin)
    monkeypatch.setattr(routes, "DEMO_USER_TTL_HOURS", 0)
    body = TestClient(app).get("/api/keepalive").json()
    assert admin.calls == []
    assert "demo_pruned" not in body


# --- uptime monitors probe with HEAD --------------------------------------


@pytest.mark.parametrize("path", ["/health", "/api/health", "/api/keepalive"])
def test_head_is_accepted_on_monitored_endpoints(monkeypatch, path):
    """UptimeRobot's HTTP(s) monitor sends HEAD by default.

    FastAPI does not add HEAD to a GET route the way plain Starlette does, so
    these answered 405 and every check was recorded as downtime.
    """
    monkeypatch.setattr(routes, "attachment_storage", StubStorage((True, "reachable")))
    monkeypatch.setattr(routes, "supabase_admin", StubAdmin())
    assert TestClient(app).head(path).status_code == 200


def test_head_keepalive_still_reaches_supabase(monkeypatch):
    """A HEAD-only monitor must still touch the project.

    The point of the endpoint is keeping Supabase from pausing, so answering
    HEAD without doing the work would defeat it.
    """
    stub = StubStorage((True, "reachable"))
    monkeypatch.setattr(routes, "attachment_storage", stub)
    monkeypatch.setattr(routes, "supabase_admin", StubAdmin())
    TestClient(app).head("/api/keepalive")
    assert stub.calls == 1


def test_head_keepalive_reports_a_degraded_project(monkeypatch):
    monkeypatch.setattr(routes, "attachment_storage", StubStorage((False, "unreachable")))
    monkeypatch.setattr(routes, "supabase_admin", StubAdmin())
    assert TestClient(app).head("/api/keepalive").status_code == 503
