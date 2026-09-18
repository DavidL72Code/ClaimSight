"""Keeps the Supabase project warm from inside the running container.

Two separate problems, and only one of them an uptime monitor can solve.

The Hugging Face Space sleeps after a stretch with no inbound HTTP, and
nothing inside the container can prevent that -- it takes real outside
traffic, which is what the monitor is for.

Supabase is different. A free project goes cold after a while, and the first
request then pays about twenty seconds to wake it; left alone long enough it
is paused outright and needs someone to press resume in the dashboard. That
does not need outside traffic, only *some* traffic, so the app can do it
itself on a schedule it controls.

Doing it here rather than on each monitor poll matters for two reasons. The
monitor's interval is not ours to rely on -- it was set to a timeout shorter
than a cold wake, so every check was logged as an outage while the service
was fine. And a request-driven touch only happens if a request arrives; this
keeps going between them.

The endpoint then reports what the loop last saw instead of making its own
call, so a monitor gets an instant answer and never times out on a cold
database. A genuinely unreachable project still surfaces, because the last
success going stale is what turns the endpoint red.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

logger = logging.getLogger("claimsight.heartbeat")


class Heartbeat:
    def __init__(
        self,
        storage: Any,
        admin: Any = None,
        *,
        interval_seconds: int = 600,
        prune_interval_seconds: int = 3600,
        demo_user_ttl_hours: int = 24,
        stale_after_seconds: int = 1800,
    ) -> None:
        self._storage = storage
        self._admin = admin
        self._interval = max(60, interval_seconds)
        self._prune_interval = max(300, prune_interval_seconds)
        self._ttl_hours = demo_user_ttl_hours
        # How long a missing success may go unreported. Deliberately a few
        # intervals, so one blip does not page anyone.
        self._stale_after = max(self._interval * 2, stale_after_seconds)

        self._task: asyncio.Task | None = None
        self._last_ok_at: float | None = None
        self._last_attempt_at: float | None = None
        self._last_detail = "not_started"
        self._beats = 0
        self._failures = 0
        self._last_prune_at: float | None = None
        self._last_pruned = 0

    # ── state the endpoint reports ──────────────────────────────────────────
    @property
    def state(self) -> dict[str, Any]:
        now = time.monotonic()
        age = None if self._last_ok_at is None else round(now - self._last_ok_at, 1)
        return {
            "supabase": self._last_detail,
            "last_success_age_seconds": age,
            "beats": self._beats,
            "failures": self._failures,
            "interval_seconds": self._interval,
            "running": bool(self._task and not self._task.done()),
            "demo_pruned_last": self._last_pruned,
        }

    @property
    def healthy(self) -> bool:
        """True while a recent touch succeeded.

        Unconfigured counts as healthy: a deployment with no Supabase
        credentials is a deliberate state, not an outage worth paging for.
        Never-yet-run also counts, so a fresh container is not red for the
        few seconds before its first beat.
        """
        if self._last_detail == "not_configured":
            return True
        if self._last_ok_at is None:
            return self._last_detail in ("not_started", "starting")
        return (time.monotonic() - self._last_ok_at) < self._stale_after

    # ── the loop ────────────────────────────────────────────────────────────
    async def _beat(self) -> None:
        reached, detail = await asyncio.to_thread(self._storage.ping)
        self._last_attempt_at = time.monotonic()
        self._last_detail = detail
        if reached:
            self._last_ok_at = self._last_attempt_at
            self._beats += 1
        elif detail != "not_configured":
            self._failures += 1
            logger.warning("Heartbeat could not reach Supabase: %s", detail)

    async def _maybe_prune(self) -> None:
        if self._admin is None or self._ttl_hours <= 0:
            return
        now = time.monotonic()
        if self._last_prune_at is not None and (now - self._last_prune_at) < self._prune_interval:
            return
        self._last_prune_at = now
        try:
            result = await asyncio.to_thread(
                self._admin.prune_anonymous_users, self._ttl_hours
            )
            self._last_pruned = int(result.get("deleted") or 0)
        except Exception as exc:  # noqa: BLE001 - housekeeping must not stop the loop
            logger.warning("Heartbeat prune skipped: %s", exc)

    async def _run(self) -> None:
        self._last_detail = "starting"
        while True:
            try:
                await self._beat()
                await self._maybe_prune()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - the loop must outlive any single failure
                self._failures += 1
                logger.warning("Heartbeat beat failed: %s", exc)
            await asyncio.sleep(self._interval)

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        try:
            self._task = asyncio.get_running_loop().create_task(self._run())
            logger.info("Heartbeat started, every %ss", self._interval)
        except RuntimeError:
            # No running loop (import-time, or a sync test). Nothing to do.
            logger.debug("Heartbeat not started: no running event loop")

    async def stop(self) -> None:
        task, self._task = self._task, None
        if not task:
            return
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
