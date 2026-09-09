"""Grant or revoke the employee/manager role on a Supabase account.

Roles live in the user's app_metadata, not in a table. Three places read the
same claim and they have to agree:

  * public.jwt_role() in supabase/migrations, used by every RLS policy
  * SupabaseAuth._normalise in the backend, used by _require_employee
  * employee-auth.js in the frontend, which gates the adjuster portal

app_metadata is writable only with the service key, which is why this script
exists. Note that the admin endpoint merges rather than replaces it: clearing
the role means sending role=null explicitly, not omitting the key. The sibling field user_metadata is writable by the user themselves,
so a role kept there could be self-assigned -- that is the whole reason the
distinction matters.

Dry run unless you pass --apply. Reads SUPABASE_URL and SUPABASE_SERVICE_KEY
from the environment or .env.

    # 1. dry run
    python supabase/scripts/set_employee_role.py adjuster@yourco.com --role employee

    # 2. apply
    python supabase/scripts/set_employee_role.py adjuster@yourco.com --role employee --apply

    # someone who has not signed up yet: create the account and email them an
    # invite so they choose their own password
    python supabase/scripts/set_employee_role.py new.hire@yourco.com --role employee --create --apply

    # remove staff access
    python supabase/scripts/set_employee_role.py ex.staff@yourco.com --revoke --apply
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import Any

import requests

VALID_ROLES = ("employee", "manager", "admin")
_TIMEOUT = 30


def _load_env() -> tuple[str, str]:
    try:
        from dotenv import load_dotenv

        load_dotenv(".env")
    except ImportError:
        pass

    url = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
    key = os.getenv("SUPABASE_SERVICE_KEY", "").strip()
    if not url or not key:
        print(
            "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set "
            "(Settings -> API in the Supabase dashboard).",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return url, key


class AdminApi:
    def __init__(self, url: str, key: str) -> None:
        self._url = url
        self._headers = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }

    def find_user(self, email: str) -> dict[str, Any] | None:
        """Look a user up by email.

        The admin list endpoint has no email filter, so this pages through
        rather than assuming the account is on the first page -- which would
        quietly start failing once the project has more than a page of users.
        """
        page = 1
        while True:
            response = requests.get(
                f"{self._url}/auth/v1/admin/users",
                headers=self._headers,
                params={"page": page, "per_page": 200},
                timeout=_TIMEOUT,
            )
            response.raise_for_status()
            users = (response.json() or {}).get("users", [])
            if not users:
                return None
            for user in users:
                if (user.get("email") or "").lower() == email.lower():
                    return user
            page += 1

    def create_user(self, email: str) -> dict[str, Any]:
        """Invite the account rather than setting a password.

        The operator never handles the new hire's credentials: Supabase emails
        an invite link and they choose their own.
        """
        response = requests.post(
            f"{self._url}/auth/v1/invite",
            headers=self._headers,
            json={"email": email},
            timeout=_TIMEOUT,
        )
        response.raise_for_status()
        return response.json() or {}

    def set_app_metadata(self, uid: str, app_metadata: dict[str, Any]) -> None:
        response = requests.put(
            f"{self._url}/auth/v1/admin/users/{uid}",
            headers=self._headers,
            json={"app_metadata": app_metadata},
            timeout=_TIMEOUT,
        )
        response.raise_for_status()

    def sign_out_everywhere(self, uid: str) -> None:
        """Revoke refresh tokens so the old role cannot linger.

        An access token already in a browser keeps its old app_metadata until
        it expires, so without this a revoked adjuster would keep employee
        access for up to an hour.
        """
        requests.post(
            f"{self._url}/auth/v1/admin/users/{uid}/logout",
            headers=self._headers,
            timeout=_TIMEOUT,
        )


def apply_role(
    api: AdminApi, email: str, role: str | None, create_missing: bool, apply_changes: bool
) -> bool:
    user = api.find_user(email)
    created = False

    if user is None:
        if not create_missing:
            print(f"  {email}: NO SUCH ACCOUNT -- have them sign up first, or pass --create")
            return False
        if not apply_changes:
            print(f"  {email}: would create the account, then grant role={role!r}")
            return True
        user = api.create_user(email)
        created = True
        if not user.get("id"):
            print(f"  {email}: invite sent but no user id came back; re-run to set the role")
            return False

    uid = user["id"]
    existing = dict(user.get("app_metadata") or {})
    current_role = existing.get("role")

    if role is None:
        if "role" not in existing:
            print(f"  {email}: already has no role -- nothing to do")
            return True
        # The admin endpoint MERGES app_metadata, so simply omitting role
        # leaves it in place -- a revoke that reported success and changed
        # nothing. Clearing it has to be explicit.
        target = {"role": None}
        action = f"REVOKE role (was {current_role!r})"
    else:
        if current_role == role and not created:
            print(f"  {email}: already role={role!r} -- nothing to do")
            return True
        # Merge semantics again: sending only role leaves provider and
        # providers untouched.
        target = {"role": role}
        action = f"set role {current_role!r} -> {role!r}"

    if created:
        action = f"invited account, {action}"

    if not apply_changes:
        print(f"  {email}: would {action}")
        return True

    api.set_app_metadata(uid, target)
    api.sign_out_everywhere(uid)
    print(f"  {email}: {action} (uid={uid}, sessions revoked)")
    if created:
        print("    an invite email has been sent; they set their own password from it")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Grant or revoke ClaimSight staff roles via Supabase app_metadata."
    )
    parser.add_argument("emails", nargs="+", help="One or more account email addresses.")
    parser.add_argument(
        "--role",
        choices=VALID_ROLES,
        help="Role to grant. Omit together with --revoke to remove staff access.",
    )
    parser.add_argument("--revoke", action="store_true", help="Remove the role claim.")
    parser.add_argument(
        "--create",
        action="store_true",
        help="Invite the account if it does not exist (they set their own password).",
    )
    parser.add_argument(
        "--apply", action="store_true", help="Apply changes instead of dry-run output."
    )
    args = parser.parse_args()

    if args.revoke and args.role:
        parser.error("--revoke and --role are mutually exclusive.")
    if not args.revoke and not args.role:
        parser.error("Pass --role {employee,manager,admin} or --revoke.")

    role = None if args.revoke else args.role
    api = AdminApi(*_load_env())

    print(f"{'APPLYING' if args.apply else 'DRY RUN'} -- {len(args.emails)} account(s)")
    failures = 0
    for email in args.emails:
        try:
            if not apply_role(api, email.strip(), role, args.create, args.apply):
                failures += 1
        except requests.HTTPError as exc:
            body = getattr(exc.response, "text", "")[:160]
            print(f"  {email}: request failed -- {exc} {body}")
            failures += 1

    if not args.apply:
        print("\nNothing was changed. Re-run with --apply to commit.")
    elif not failures:
        print("\nDone. Affected users must sign in again to receive the new role.")

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
