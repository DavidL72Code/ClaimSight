from fastapi.testclient import TestClient

from app.main import app
from app.api import routes
from app.core import config


client = TestClient(app)


def test_health_endpoint() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["segmentation_provider"] == config.SEGMENTATION_PROVIDER
    assert "active_segmentation_provider" in payload
    assert payload.get("segmentation_load_error") is None or isinstance(payload["segmentation_load_error"], bool)


def test_assess_damage_rejects_invalid_file_type() -> None:
    original_verify = routes.supabase_auth.verify_bearer_token
    routes.supabase_auth.verify_bearer_token = lambda authorization: {"uid": "customer-1", "role": "customer"}
    try:
        response = client.post(
            "/api/assess",
            files={"file": ("notes.txt", b"not an image", "text/plain")},
        )
        assert response.status_code == 400
    finally:
        routes.supabase_auth.verify_bearer_token = original_verify


def test_assess_damage_rejects_spoofed_image_content() -> None:
    original_verify = routes.supabase_auth.verify_bearer_token
    routes.supabase_auth.verify_bearer_token = lambda authorization: {"uid": "customer-1", "role": "customer"}
    try:
        response = client.post(
            "/api/assess",
            files={"file": ("fake.png", b"not really an image", "image/png")},
        )
        assert response.status_code == 400
    finally:
        routes.supabase_auth.verify_bearer_token = original_verify


def test_assess_damage_requires_authentication() -> None:
    original_verify = routes.supabase_auth.verify_bearer_token
    routes.supabase_auth.verify_bearer_token = lambda authorization: None
    try:
        response = client.post(
            "/api/assess",
            files={"file": ("fake.png", b"not really an image", "image/png")},
        )
        assert response.status_code == 401
    finally:
        routes.supabase_auth.verify_bearer_token = original_verify
