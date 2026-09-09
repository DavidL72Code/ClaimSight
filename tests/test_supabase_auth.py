"""Tests for Supabase token verification and the RLS-backed access path."""

import time

import jwt
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.api import routes
from app.services.supabase_auth import SupabaseAuth

# 32+ bytes, as SHA256 wants; a shorter one only produces warnings.
SECRET = "test-jwt-secret-not-a-real-one-abcdefghijklmnop"
URL = "https://stub.supabase.co"
UID = "11111111-1111-1111-1111-111111111111"


def make_token(secret=SECRET, **overrides):
    payload = {
        "sub": UID,
        "email": "alice@example.com",
        "aud": "authenticated",
        "iss": f"{URL}/auth/v1",
        "exp": int(time.time()) + 3600,
        "app_metadata": {},
        "user_metadata": {},
    }
    payload.update(overrides)
    return jwt.encode(payload, secret, algorithm="HS256")


@pytest.fixture
def auth(monkeypatch):
    a = SupabaseAuth()
    monkeypatch.setattr(a, "_url", URL)
    monkeypatch.setattr(a, "_secret", SECRET)
    # No JWKS endpoint in tests; force the symmetric path.
    monkeypatch.setattr(a, "_jwks_failed", True)
    return a


def test_valid_token_is_accepted(auth):
    claims = auth.verify_bearer_token(f"Bearer {make_token()}")
    assert claims["uid"] == UID
    assert claims["email"] == "alice@example.com"
    assert claims["role"] == ""


def test_role_is_read_from_app_metadata(auth):
    token = make_token(app_metadata={"role": "employee"})
    assert auth.verify_bearer_token(f"Bearer {token}")["role"] == "employee"


def test_role_in_user_metadata_is_ignored(auth):
    """user_metadata is user-editable, so a role there must not be trusted.

    This is the escalation that matters: if the role were read from
    user_metadata, any signed-in customer could call updateUser and become an
    adjuster. public.jwt_role() in the RLS migration reads app_metadata too,
    so the API and the database agree.
    """
    token = make_token(user_metadata={"role": "manager"}, app_metadata={})
    assert auth.verify_bearer_token(f"Bearer {token}")["role"] == ""


def test_token_signed_with_the_wrong_secret_is_refused(auth):
    assert auth.verify_bearer_token(f"Bearer {make_token(secret='attacker-secret-also-32-bytes-long-xxxxxx')}") is None


def test_expired_token_is_refused(auth):
    assert auth.verify_bearer_token(f"Bearer {make_token(exp=int(time.time()) - 60)}") is None


def test_wrong_audience_is_refused(auth):
    assert auth.verify_bearer_token(f"Bearer {make_token(aud='anon')}") is None


def test_wrong_issuer_is_refused(auth):
    token = make_token(iss="https://evil.supabase.co/auth/v1")
    assert auth.verify_bearer_token(f"Bearer {token}") is None


def test_unsigned_token_is_refused(auth):
    # alg=none must never be honoured.
    token = jwt.encode({"sub": UID, "aud": "authenticated"}, "", algorithm="none")
    assert auth.verify_bearer_token(f"Bearer {token}") is None


def test_token_without_subject_is_refused(auth):
    assert auth.verify_bearer_token(f"Bearer {make_token(sub='')}") is None


def test_non_bearer_scheme_is_refused(auth):
    assert auth.verify_bearer_token(f"Basic {make_token()}") is None
    assert auth.verify_bearer_token("") is None


def test_unconfigured_verifier_refuses_everything(monkeypatch):
    a = SupabaseAuth()
    monkeypatch.setattr(a, "_url", "")
    assert a.verify_bearer_token(f"Bearer {make_token()}") is None


# --- the route-level path -------------------------------------------------


class StubData:
    ready = True

    def __init__(self, row):
        self.row = row
        self.queries = []

    def describe_case_access(self, *, access_token, case_id, uid, email, role):
        self.queries.append((access_token, case_id))
        if self.row is None:
            return {"visible": False, "is_owner": False,
                    "is_assigned_employee": False, "is_manager": False}
        assigned = (self.row.get("assigned_agent_email") or "").lower()
        return {
            "visible": True,
            "is_owner": str(self.row.get("owner_uid") or "") == uid,
            "is_assigned_employee": role == "employee" and email.lower() == assigned,
            "is_manager": role in {"manager", "admin"},
            "case": self.row,
        }


class StubStorage:
    ready = True

    def __init__(self):
        self.uploads = []

    def upload(self, *, folder_key, case_id, filename, content, content_type):
        self.uploads.append((folder_key, case_id))
        return {"path": f"{folder_key}/{case_id}/{filename}",
                "download_url": f"https://stub/{folder_key}/{case_id}/{filename}"}


def _client(monkeypatch, row, auth_obj, storage):
    monkeypatch.setattr(routes, "supabase_auth", auth_obj)
    monkeypatch.setattr(routes, "supabase_data", StubData(row))
    monkeypatch.setattr(routes, "attachment_storage", storage)
    monkeypatch.setattr(routes, "_enforce_rate_limit", lambda *a, **k: None)
    return TestClient(app)


def _upload(client, token, folder="messages"):
    import io
    return client.post(
        "/api/attachments",
        data={"case_id": "CLM-1", "folder": folder},
        files={"file": ("a.png", io.BytesIO(b"png"), "image/png")},
        headers={"Authorization": f"Bearer {token}"},
    )


ROW = {"id": "CLM-1", "owner_uid": UID, "assigned_agent_email": "adjuster@claimsight.com"}


def test_owner_upload_uses_the_supabase_path(monkeypatch, auth):
    storage = StubStorage()
    client = _client(monkeypatch, ROW, auth, storage)
    assert _upload(client, make_token()).status_code == 200
    assert storage.uploads == [("messages", "CLM-1")]


def test_invisible_case_is_404_not_403(monkeypatch, auth):
    """RLS hiding a row must not become an existence oracle."""
    storage = StubStorage()
    client = _client(monkeypatch, None, auth, storage)
    assert _upload(client, make_token()).status_code == 404
    assert storage.uploads == []


def test_owner_still_cannot_file_reviewer_evidence(monkeypatch, auth):
    storage = StubStorage()
    client = _client(monkeypatch, ROW, auth, storage)
    assert _upload(client, make_token(), folder="reviewer-evidence").status_code == 403
    assert storage.uploads == []


def test_assigned_adjuster_may_file_reviewer_evidence(monkeypatch, auth):
    storage = StubStorage()
    client = _client(monkeypatch, ROW, auth, storage)
    token = make_token(email="adjuster@claimsight.com", app_metadata={"role": "employee"})
    assert _upload(client, token, folder="reviewer-evidence").status_code == 200


def test_the_users_own_token_is_forwarded_to_postgrest(monkeypatch, auth):
    """The query must run as the caller, or RLS is not enforcing anything."""
    storage = StubStorage()
    monkeypatch.setattr(routes, "supabase_auth", auth)
    data = StubData(ROW)
    monkeypatch.setattr(routes, "supabase_data", data)
    monkeypatch.setattr(routes, "attachment_storage", storage)
    monkeypatch.setattr(routes, "_enforce_rate_limit", lambda *a, **k: None)
    token = make_token()
    _upload(TestClient(app), token)
    assert data.queries and data.queries[0][0] == token
