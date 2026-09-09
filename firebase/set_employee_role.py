"""Grant or revoke the employee/manager role on a production Firebase account.

Roles live in Firebase custom claims, not in Firestore: firestore.rules and
storage.rules both gate on request.auth.token.role, and the backend checks the
same claim in _require_employee. Custom claims can only be written with the
Admin SDK, so this is the only supported way to create staff access.

Run without --apply for a dry run. Firebase Admin credentials are loaded through
FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_SERVICE_ACCOUNT_PATH, or
GOOGLE_APPLICATION_CREDENTIALS.

    # 1. dry run
    python firebase/set_employee_role.py adjuster@yourco.com --role employee

    # 2. apply
    python firebase/set_employee_role.py adjuster@yourco.com --role employee --apply

    # someone who has not signed up yet: create a passwordless account and
    # print a link for them to set their own password
    python firebase/set_employee_role.py new.hire@yourco.com --role employee --create --apply

    # remove staff access (e.g. someone leaves)
    python firebase/set_employee_role.py ex.staff@yourco.com --revoke --apply
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import firebase_admin
from firebase_admin import auth, credentials

# Exactly the values firestore.rules / storage.rules / _require_employee accept.
# "manager" and "admin" are both treated as manager-level by the rules.
VALID_ROLES = ("employee", "manager", "admin")


def initialize_firebase() -> None:
    if firebase_admin._apps:
        return
    service_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    service_path = os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH", "").strip()
    if service_json:
        firebase_admin.initialize_app(credentials.Certificate(json.loads(service_json)))
    elif service_path:
        firebase_admin.initialize_app(credentials.Certificate(service_path))
    else:
        firebase_admin.initialize_app()


def resolve_user(email: str, create_missing: bool, apply_changes: bool):
    """Return the auth user record, optionally creating it."""
    try:
        return auth.get_user_by_email(email), False
    except auth.UserNotFoundError:
        if not create_missing:
            raise
        if not apply_changes:
            print(f"  would create a new account for {email}")
            return None, True
        # Deliberately created without a password: the operator never handles
        # the new hire's credentials, and the reset link below lets them set
        # their own. email_verified stays False until they act on it.
        return auth.create_user(email=email, email_verified=False), True


def apply_role(email: str, role: str | None, create_missing: bool, apply_changes: bool) -> bool:
    try:
        user, created = resolve_user(email, create_missing, apply_changes)
    except auth.UserNotFoundError:
        print(f"  {email}: NO SUCH ACCOUNT — have them sign in once first, or pass --create")
        return False

    if user is None:  # dry run, account would have been created
        print(f"  {email}: would then be granted role={role!r}")
        return True

    existing = dict(user.custom_claims or {})
    current_role = existing.get("role")

    if role is None:
        if "role" not in existing:
            print(f"  {email}: already has no role — nothing to do")
            return True
        target = {k: v for k, v in existing.items() if k != "role"}
        action = f"REVOKE role (was {current_role!r})"
    else:
        if current_role == role:
            print(f"  {email}: already role={role!r} — nothing to do")
            return True
        # Merge rather than replace: set_custom_user_claims overwrites the whole
        # claims object, so any unrelated claims would be silently dropped.
        target = {**existing, "role": role}
        action = f"set role {current_role!r} -> {role!r}"

    if created:
        action = f"created account, {action}"

    if not apply_changes:
        print(f"  {email}: would {action}")
        return True

    auth.set_custom_user_claims(user.uid, target or None)

    # A already-issued ID token keeps the old claims for up to an hour, so force
    # the next request to mint a fresh one. The client must then call
    # getIdToken(true) (or simply sign in again) to pick up the new role.
    auth.revoke_refresh_tokens(user.uid)

    print(f"  {email}: {action} (uid={user.uid}, refresh tokens revoked)")

    if created:
        try:
            link = auth.generate_password_reset_link(email)
            print(f"    send them this link to set a password:\n    {link}")
        except Exception as exc:  # noqa: BLE001 - surfacing is enough here
            print(f"    could not generate a password reset link: {exc}")
            print("    send one from the Firebase console instead.")

    return True


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Grant or revoke ClaimSight staff roles via Firebase custom claims."
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
        help="Create the account if it does not exist (no password; prints a reset link).",
    )
    parser.add_argument("--apply", action="store_true", help="Apply changes instead of dry-run output.")
    args = parser.parse_args()

    if args.revoke and args.role:
        parser.error("--revoke and --role are mutually exclusive.")
    if not args.revoke and not args.role:
        parser.error("Pass --role {employee,manager,admin} or --revoke.")

    role = None if args.revoke else args.role

    initialize_firebase()

    print(f"{'APPLYING' if args.apply else 'DRY RUN'} — {len(args.emails)} account(s)")
    failures = 0
    for email in args.emails:
        if not apply_role(email.strip(), role, args.create, args.apply):
            failures += 1

    if not args.apply:
        print("\nNothing was changed. Re-run with --apply to commit.")
    elif not failures:
        print("\nDone. Affected users must sign in again to receive the new claim.")

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
