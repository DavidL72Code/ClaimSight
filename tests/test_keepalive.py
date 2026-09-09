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
