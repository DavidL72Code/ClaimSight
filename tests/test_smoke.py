from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_health_endpoint() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["segmentation_provider"] == "sam2"
    assert "active_segmentation_provider" in payload
    assert isinstance(payload.get("segmentation_load_error"), bool)


def test_assess_damage_rejects_invalid_file_type() -> None:
    response = client.post(
        "/api/assess",
        files={"file": ("notes.txt", b"not an image", "text/plain")},
    )
    assert response.status_code == 400


def test_assess_damage_rejects_spoofed_image_content() -> None:
    response = client.post(
        "/api/assess",
        files={"file": ("fake.png", b"not really an image", "image/png")},
    )
    assert response.status_code == 400
