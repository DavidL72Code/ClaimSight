"""The endpoint an uptime monitor polls, and the loop behind it.

Two things are being kept alive and only one of them a monitor can help with.
The Space sleeps without inbound HTTP, so the polling itself is what keeps it
up. Supabase goes cold, and eventually paused, on its own clock -- and a cold
project takes about twenty seconds to answer, which is longer than a monitor's
timeout. Touching it inline therefore turned a healthy service into a logged
outage, so the loop does the touching and the endpoint only reports what it
last saw.
"""

import asyncio
import time

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.api import routes
from app.services.heartbeat import Heartbeat


class StubStorage:
    def __init__(self, result=(True, "reachable"), delay=0.0):
        self.result = result
        self.delay = delay
        self.calls = 0

    def ping(self):
        self.calls += 1
        if self.delay:
            time.sleep(self.delay)
        return self.result


class StubAdmin:
    def __init__(self, deleted=0, fail=False):
        self.deleted = deleted
        self.fail = fail
        self.calls = 0

    def prune_anonymous_users(self, older_than_hours=24, limit=200):
        self.calls += 1
        if self.fail:
            raise RuntimeError("listing refused")
        return {"deleted": self.deleted, "examined": 3, "older_than_hours": older_than_hours}


def _install(monkeypatch, hb):
    monkeypatch.setattr(routes, "heartbeat", hb)
    monkeypatch.setattr(routes, "_enforce_rate_limit", lambda *a, **k: None)
    monkeypatch.setattr(routes, "HEARTBEAT_INTERVAL_SECONDS", 600)
    return TestClient(app)


# --- the endpoint ---------------------------------------------------------


def test_reports_ok_from_a_recent_beat(monkeypatch):
    hb = Heartbeat(StubStorage())
    asyncio.run(hb._beat())
    body = _install(monkeypatch, hb).get("/api/keepalive").json()
    assert body["status"] == "ok"
    assert body["supabase"] == "reachable"
    assert body["beats"] == 1


def test_answers_without_touching_supabase(monkeypatch):
    """The whole point: the poll must not pay the cold-start cost."""
    storage = StubStorage()
    hb = Heartbeat(storage)
    asyncio.run(hb._beat())
    before = storage.calls
    client = _install(monkeypatch, hb)
    for _ in range(20):
        assert client.get("/api/keepalive").status_code == 200
    assert storage.calls == before, "the endpoint made its own Supabase call"


def test_a_cold_supabase_does_not_slow_the_endpoint(monkeypatch):
    """A twenty-second wake must not become a twenty-second response."""
    hb = Heartbeat(StubStorage(delay=2.0))
    asyncio.run(hb._beat())          # pays the cost once, in the loop
    client = _install(monkeypatch, hb)
    started = time.monotonic()
    client.get("/api/keepalive")
    assert time.monotonic() - started < 0.5


def test_503_once_the_last_success_goes_stale(monkeypatch):
    hb = Heartbeat(StubStorage(), stale_after_seconds=60)
    asyncio.run(hb._beat())
    hb._last_ok_at -= 10_000        # age it well past the window
    assert _install(monkeypatch, hb).get("/api/keepalive").status_code == 503


def test_unconfigured_is_not_an_outage(monkeypatch):
    hb = Heartbeat(StubStorage((False, "not_configured")))
    asyncio.run(hb._beat())
    response = _install(monkeypatch, hb).get("/api/keepalive")
    assert response.status_code == 200
    assert response.json()["supabase"] == "not_configured"


def test_a_fresh_container_is_not_red_before_its_first_beat(monkeypatch):
    hb = Heartbeat(StubStorage())
    assert _install(monkeypatch, hb).get("/api/keepalive").status_code == 200


def test_one_failed_beat_does_not_page(monkeypatch):
    """Staleness pages, a single blip does not."""
    hb = Heartbeat(StubStorage(), stale_after_seconds=3600)
    asyncio.run(hb._beat())
    hb._storage.result = (False, "unreachable")
    asyncio.run(hb._beat())
    assert _install(monkeypatch, hb).get("/api/keepalive").status_code == 200


@pytest.mark.parametrize("path", ["/health", "/api/health", "/api/keepalive"])
def test_head_is_accepted(monkeypatch, path):
    """Uptime monitors send HEAD by default; FastAPI registers GET only."""
    hb = Heartbeat(StubStorage())
    asyncio.run(hb._beat())
    assert _install(monkeypatch, hb).head(path).status_code == 200


def test_falls_back_to_an_inline_touch_when_the_loop_is_off(monkeypatch):
    storage = StubStorage()
    hb = Heartbeat(storage)
    monkeypatch.setattr(routes, "heartbeat", hb)
    monkeypatch.setattr(routes, "attachment_storage", storage)
    monkeypatch.setattr(routes, "_enforce_rate_limit", lambda *a, **k: None)
    monkeypatch.setattr(routes, "HEARTBEAT_INTERVAL_SECONDS", 0)
    body = TestClient(app).get("/api/keepalive").json()
    assert body["heartbeat"] == "disabled"
    assert storage.calls == 1


# --- the loop ------------------------------------------------------------


def test_the_loop_beats_repeatedly():
    async def run():
        storage = StubStorage()
        hb = Heartbeat(storage, interval_seconds=60)
        hb._interval = 0.05                     # keep the test quick
        hb.start()
        await asyncio.sleep(0.3)
        await hb.stop()
        return storage.calls

    assert asyncio.run(run()) >= 3


def test_the_loop_survives_a_failing_ping():
    """A loop that dies on one error would let the project pause silently."""
    class Exploding(StubStorage):
        def ping(self):
            self.calls += 1
            raise RuntimeError("network gone")

    async def run():
        storage = Exploding()
        hb = Heartbeat(storage, interval_seconds=60)
        hb._interval = 0.05
        hb.start()
        await asyncio.sleep(0.3)
        running = hb.state["running"]
        await hb.stop()
        return storage.calls, running

    calls, running = asyncio.run(run())
    assert calls >= 3 and running


def test_the_loop_prunes_on_its_own_slower_schedule():
    async def run():
        admin = StubAdmin(deleted=2)
        hb = Heartbeat(StubStorage(), admin, interval_seconds=60, prune_interval_seconds=300)
        hb._interval = 0.05
        hb._prune_interval = 10_000             # once, then never again in this window
        hb.start()
        await asyncio.sleep(0.3)
        await hb.stop()
        return admin.calls, hb.state["demo_pruned_last"]

    calls, pruned = asyncio.run(run())
    assert calls == 1 and pruned == 2


def test_a_failing_prune_does_not_stop_the_beats():
    async def run():
        storage = StubStorage()
        hb = Heartbeat(storage, StubAdmin(fail=True), interval_seconds=60)
        hb._interval = 0.05
        hb._prune_interval = 0
        hb.start()
        await asyncio.sleep(0.3)
        await hb.stop()
        return storage.calls

    assert asyncio.run(run()) >= 3


def test_stop_is_safe_when_never_started():
    asyncio.run(Heartbeat(StubStorage()).stop())
