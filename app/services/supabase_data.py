"""Reads claim data from Supabase through PostgREST.

The important property here is *whose* credentials are used. Requests carry
the caller's own access token, not the service key, so PostgREST runs them as
the `authenticated` role and the RLS policies in supabase/migrations decide
what comes back.

That is a deliberate improvement on the Firebase arrangement it replaces.
There, the backend held an Admin SDK credential that bypassed Security Rules
entirely, so every check had to be re-implemented in Python and trusted --
which is exactly the risk David objected to. Here a bug in this file cannot
widen access: if the policies do not grant it, PostgREST returns nothing.

The service key stays reserved for work that is genuinely administrative --
storing an attachment, setting a user's role -- and is never used to answer a
question about what a given user may see.
"""

from __future__ import annotations

import logging
from typing import Any

from app.core.config import SUPABASE_ANON_KEY, SUPABASE_URL

logger = logging.getLogger("claimsight.supabase_data")


class SupabaseDataError(RuntimeError):
    pass


class SupabaseData:
    def __init__(self) -> None:
        self._url = SUPABASE_URL
        self._anon_key = SUPABASE_ANON_KEY

    @property
    def ready(self) -> bool:
        return bool(self._url and self._anon_key)

    def _headers(self, access_token: str) -> dict[str, str]:
        # apikey identifies the project; Authorization carries the user. Both
        # are required -- PostgREST rejects a request missing either.
        return {
            "apikey": self._anon_key,
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
        }

    def _get(self, path: str, access_token: str, params: dict[str, str]) -> list[dict[str, Any]]:
        if not self.ready:
            raise SupabaseDataError("Supabase is not configured.")

        import requests

        try:
            response = requests.get(
                f"{self._url}/rest/v1/{path}",
                headers=self._headers(access_token),
                params=params,
                timeout=20,
            )
        except Exception as exc:
            logger.warning("Supabase query failed for %s: %s", path, exc)
            raise SupabaseDataError("Could not reach the database.") from exc

        # 401/403 mean the token is bad or expired. An RLS refusal is not an
        # error status -- it comes back as an empty result set.
        if response.status_code in (401, 403):
            return []
        if response.status_code >= 400:
            logger.warning("Supabase query rejected %s: %s", path, response.status_code)
            raise SupabaseDataError("The database rejected the query.")

        payload = response.json()
        return payload if isinstance(payload, list) else []

    def get_case(self, access_token: str, case_id: str) -> dict[str, Any] | None:
        """Fetch one case as the caller, or None if RLS does not show it.

        None deliberately conflates "does not exist" and "not yours". The
        policies do not distinguish them either, and neither should the API:
        answering differently would turn this into an oracle for whether a
        given claim id exists.
        """
        if not case_id:
            return None
        rows = self._get(
            "cases",
            access_token,
            {"id": f"eq.{case_id}", "select": "*", "limit": "1"},
        )
        return rows[0] if rows else None

    def list_cases(self, access_token: str, limit: int = 25) -> list[dict[str, Any]]:
        """Cases the caller may see, newest first.

        No owner filter is applied on purpose: the select policy already
        narrows this to the caller's own cases, or to the ones assigned to
        them if they are an adjuster.
        """
        return self._get(
            "cases",
            access_token,
            {"select": "*", "order": "updated_at.desc", "limit": str(max(1, min(limit, 100)))},
        )

    def list_case_activity(
        self, access_token: str, case_id: str, limit: int = 100
    ) -> list[dict[str, Any]]:
        return self._get(
            "case_activity",
            access_token,
            {
                "case_id": f"eq.{case_id}",
                "select": "*",
                "order": "created_at.desc",
                "limit": str(max(1, min(limit, 500))),
            },
        )

    def describe_case_access(
        self,
        *,
        access_token: str,
        case_id: str,
        uid: str,
        email: str,
        role: str,
    ) -> dict[str, Any]:
        """What the caller may do with one case.

        Visibility is answered by RLS rather than re-derived here: if the
        select policy does not return the row, there is nothing to decide.
        The assigned-adjuster distinction is read off the returned row because
        reviewer evidence is narrower than read access -- a customer can see
        their own case but must not file evidence into the adjuster's folder.
        """
        row = self.get_case(access_token, case_id)
        if row is None:
            return {
                "visible": False,
                "is_owner": False,
                "is_assigned_employee": False,
                "is_manager": role in {"manager", "admin"},
            }

        assigned = (row.get("assigned_agent_email") or "").lower()
        return {
            "visible": True,
            "is_owner": bool(uid) and str(row.get("owner_uid") or "") == uid,
            "is_assigned_employee": role == "employee" and bool(email) and assigned == email.lower(),
            "is_manager": role in {"manager", "admin"},
            "case": row,
        }
