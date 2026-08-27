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
    original_verify = routes.firebase_claim_lookup.verify_bearer_token
    routes.firebase_claim_lookup.verify_bearer_token = lambda authorization: None
    try:
        response = client.post("/api/claim-assistant", json=_assistant_payload())
        assert response.status_code == 401
    finally:
        routes.firebase_claim_lookup.verify_bearer_token = original_verify


def test_claim_assistant_hides_unowned_claims() -> None:
    original_verify = routes.firebase_claim_lookup.verify_bearer_token
    original_lookup = routes.firebase_claim_lookup.get_owned_claim_context
    routes.firebase_claim_lookup.verify_bearer_token = lambda authorization: {
        "uid": "customer-1",
        "email": "customer@example.com",
        "role": "customer",
    }
    routes.firebase_claim_lookup.get_owned_claim_context = lambda uid, claim_reference: None
    try:
        response = client.post("/api/claim-assistant", json=_assistant_payload())
        assert response.status_code == 404
    finally:
        routes.firebase_claim_lookup.verify_bearer_token = original_verify
        routes.firebase_claim_lookup.get_owned_claim_context = original_lookup
