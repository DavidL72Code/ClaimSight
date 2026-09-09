"""Access-control tests for POST /api/attachments.

Firebase Storage rules cannot protect this path: the backend uses the Admin
SDK, which bypasses Security Rules. These tests stand in for the storage.rules
coverage that no longer applies, so they check the boundary directly rather
than trusting it.
"""

import io

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.api import routes


CASES = {
    "case-owned-by-alice": {
        "owner_uid": "alice-uid",
        "assigned_agent": {"email": "adjuster@claimsight.com"},
    },
}


class FakeLookup:
    """Stands in for FirebaseClaimLookup with a fixed token and case table."""

    ready = True

    def __init__(self, token):
        self._token = token

    def verify_bearer_token(self, authorization):
        if not authorization:
            return None
        return self._token

    def describe_case_access(self, *, case_id, uid, email, role):
        payload = CASES.get(case_id)
        result = {
            "exists": payload is not None,
            "is_owner": False,
            "is_assigned_employee": False,
            "is_manager": role in {"manager", "admin"},
            "allowed": False,
        }
        if payload is None:
            return result
        assigned = (payload.get("assigned_agent") or {}).get("email", "").lower()
        result["is_owner"] = payload.get("owner_uid") == uid
        result["is_assigned_employee"] = role == "employee" and email.lower() == assigned
        result["allowed"] = (
            result["is_owner"] or result["is_assigned_employee"] or result["is_manager"]
        )
        return result


class FakeStorage:
    ready = True

    def __init__(self):
        self.uploads = []

    def upload(self, *, folder_key, case_id, filename, content, content_type):
        self.uploads.append((folder_key, case_id, filename, len(content)))
        return {
            "path": f"{folder_key}/{case_id}/{filename}",
            "download_url": f"https://stub.supabase.co/{folder_key}/{case_id}/{filename}",
        }


@pytest.fixture
def client_for(monkeypatch):
    def _build(token, storage=None):
        monkeypatch.setattr(routes, "firebase_claim_lookup", FakeLookup(token))
        monkeypatch.setattr(routes, "attachment_storage", storage or FakeStorage())
        # The rate limiter keys on uid and would trip across parametrised runs.
        monkeypatch.setattr(routes, "_enforce_rate_limit", lambda *a, **k: None)
        return TestClient(app)

    return _build


def _post(client, case_id="case-owned-by-alice", folder="messages", ctype="image/png"):
    return client.post(
        "/api/attachments",
        data={"case_id": case_id, "folder": folder},
        files={"file": ("evidence.png", io.BytesIO(b"\x89PNG fake bytes"), ctype)},
        headers={"Authorization": "Bearer stub"},
    )


OWNER = {"uid": "alice-uid", "email": "alice@example.com", "role": ""}
STRANGER = {"uid": "bob-uid", "email": "bob@example.com", "role": ""}
ASSIGNED = {"uid": "emp-uid", "email": "adjuster@claimsight.com", "role": "employee"}
UNASSIGNED = {"uid": "emp2-uid", "email": "other@claimsight.com", "role": "employee"}
MANAGER = {"uid": "mgr-uid", "email": "boss@claimsight.com", "role": "manager"}


def test_unauthenticated_request_is_rejected(client_for):
    client = client_for(OWNER)
    response = client.post(
        "/api/attachments",
        data={"case_id": "case-owned-by-alice", "folder": "messages"},
        files={"file": ("x.png", io.BytesIO(b"x"), "image/png")},
    )
    assert response.status_code == 401


def test_owner_can_upload_to_own_case(client_for):
    storage = FakeStorage()
    response = _post(client_for(OWNER, storage))
    assert response.status_code == 200, response.text
    assert response.json()["download_url"].startswith("https://stub.supabase.co/")
    assert len(storage.uploads) == 1


def test_stranger_cannot_upload_to_someone_elses_case(client_for):
    storage = FakeStorage()
    response = _post(client_for(STRANGER, storage))
    assert response.status_code == 403
    assert storage.uploads == []


def test_assigned_adjuster_can_upload(client_for):
    response = _post(client_for(ASSIGNED))
    assert response.status_code == 200, response.text


def test_unassigned_employee_cannot_upload(client_for):
    storage = FakeStorage()
    response = _post(client_for(UNASSIGNED, storage))
    assert response.status_code == 403
    assert storage.uploads == []


def test_only_assigned_adjuster_may_file_reviewer_evidence(client_for):
    # The owner has access to the case but must not be able to plant evidence
    # in the adjuster's folder -- storage.rules drew the same line.
    storage = FakeStorage()
    response = _post(client_for(OWNER, storage), folder="reviewer-evidence")
    assert response.status_code == 403
    assert storage.uploads == []

    assert _post(client_for(ASSIGNED), folder="reviewer-evidence").status_code == 200


def test_manager_may_upload_anywhere(client_for):
    assert _post(client_for(MANAGER), folder="reviewer-evidence").status_code == 200


def test_missing_case_is_404_not_403(client_for):
    response = _post(client_for(OWNER), case_id="no-such-case")
    assert response.status_code == 404


def test_unknown_folder_is_rejected(client_for):
    storage = FakeStorage()
    response = _post(client_for(OWNER, storage), folder="../../etc")
    assert response.status_code == 400
    assert storage.uploads == []


def test_disallowed_content_type_is_rejected(client_for):
    storage = FakeStorage()
    response = _post(client_for(OWNER, storage), ctype="application/x-sh")
    assert response.status_code == 415
    assert storage.uploads == []


def test_oversized_upload_is_rejected(client_for, monkeypatch):
    storage = FakeStorage()
    monkeypatch.setattr(routes, "MAX_UPLOAD_BYTES", 16)
    client = client_for(OWNER, storage)
    response = client.post(
        "/api/attachments",
        data={"case_id": "case-owned-by-alice", "folder": "messages"},
        files={"file": ("big.png", io.BytesIO(b"x" * 64), "image/png")},
        headers={"Authorization": "Bearer stub"},
    )
    assert response.status_code == 413
    assert storage.uploads == []


def test_unconfigured_storage_returns_503(client_for):
    class Unconfigured(FakeStorage):
        ready = False

    response = _post(client_for(OWNER, Unconfigured()))
    assert response.status_code == 503


def test_object_paths_are_sanitised():
    from app.services.attachment_storage import safe_object_name

    # Path separators and traversal dots must not survive into the object key.
    assert safe_object_name("../../etc/passwd") == "_.._etc_passwd"
    assert safe_object_name("...hidden") == "hidden"
    assert safe_object_name("") == "attachment"
    assert safe_object_name("my file (1).png") == "my-file-_1_.png"
    assert len(safe_object_name("a" * 500)) == 120
