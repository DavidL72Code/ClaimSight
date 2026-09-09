from fastapi.testclient import TestClient

from app.api import routes
from app.main import app


client = TestClient(app)


def _assistant_payload() -> dict:
    return {
        "message": "What is my claim status?",
        "context": {"claim_reference": "CLM-SECURE-1"},
        "history": [],
    }


def test_claim_assistant_requires_authentication() -> None:
    original_verify = routes.supabase_auth.verify_bearer_token
    routes.supabase_auth.verify_bearer_token = lambda authorization: None
    try:
        response = client.post("/api/claim-assistant", json=_assistant_payload())
        assert response.status_code == 401
    finally:
        routes.supabase_auth.verify_bearer_token = original_verify


def test_claim_assistant_hides_unowned_claims() -> None:
    original_verify = routes.supabase_auth.verify_bearer_token
    original_lookup = routes.supabase_data.get_owned_claim_context
    routes.supabase_auth.verify_bearer_token = lambda authorization: {
        "uid": "customer-1",
        "email": "customer@example.com",
        "role": "customer",
    }
    # RLS decides ownership now, so "not yours" arrives as an empty result --
    # which the endpoint must still turn into 404 rather than leaking that the
    # claim exists.
    routes.supabase_data.get_owned_claim_context = lambda access_token, claim_reference: None
    try:
        response = client.post("/api/claim-assistant", json=_assistant_payload())
        assert response.status_code == 404
    finally:
        routes.supabase_auth.verify_bearer_token = original_verify
        routes.supabase_data.get_owned_claim_context = original_lookup
