"""Move legacy internal_notes out of customer-readable case documents.

Run without arguments for a dry run. Pass --apply to perform the migration.
Firebase Admin credentials are loaded through FIREBASE_SERVICE_ACCOUNT_JSON,
FIREBASE_SERVICE_ACCOUNT_PATH, or GOOGLE_APPLICATION_CREDENTIALS.
"""

from __future__ import annotations

import argparse
import json
import os

import firebase_admin
from firebase_admin import credentials, firestore


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


def migrate(apply_changes: bool) -> int:
    initialize_firebase()
    db = firestore.client()
    migrated = 0
    for case_doc in db.collection("cases").stream():
        payload = case_doc.to_dict() or {}
        if "internal_notes" not in payload:
            continue
        migrated += 1
        print(f"{case_doc.id}: legacy internal note found")
        if not apply_changes:
            continue
        db.collection("case_internal").document(case_doc.id).set(
            {
                "note": str(payload.get("internal_notes") or ""),
                "migrated_at": firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )
        case_doc.reference.update({"internal_notes": firestore.DELETE_FIELD})
    return migrated


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Apply changes instead of dry-run output.")
    args = parser.parse_args()
    count = migrate(args.apply)
    mode = "migrated" if args.apply else "found"
    print(f"{count} case(s) {mode}.")
