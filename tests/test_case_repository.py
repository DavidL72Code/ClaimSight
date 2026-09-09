from __future__ import annotations

from copy import deepcopy

from fastapi.testclient import TestClient

from app.main import app
from app.api import routes
from app.services.case_repository import CaseRepository


client = TestClient(app)


def _employee_token(authorization: str) -> dict | None:
    return {"uid": "employee-1", "email": "alex.morgan@claimsight.com", "role": "employee"}


def _sample_case_payload() -> dict:
    return {
        "filename": "claim.jpg",
        "filenames": ["claim.jpg"],
        "vehicle_type": "2023 Audi RS e-tron GT Prestige",
        "estimated_vehicle_value_usd": 62000,
        "valuation_methodology": "Grounded from comparable listings.",
        "valuation_comparable_prices_usd": [61000, 62500, 64000],
        "total_loss": False,
        "total_loss_reason": "",
        "overall_severity": "high",
        "repairability": "review for total loss",
        "estimated_total_cost_usd": 21000,
        "recommended_action": "Escalate to adjuster for detailed review",
        "summary": "Assessment summary",
        "regions": [
            {
                "part_id": "P1",
                "panel": "front bumper",
                "damage_type": "crack",
                "severity": "high",
                "confidence": 0.92,
                "bounding_box": {"x": 10, "y": 20, "width": 100, "height": 80},
                "estimated_repair_cost_usd": 9000,
                "source": "mock",
                "image_index": 0,
                "ai_assessor_model": "mock-model",
                "mask_png": "",
                "vehicle_value_usd": 62000,
                "vehicle_label": "Audi RS e-tron GT",
                "vehicle_total_loss": False,
                "total_loss_reason": "",
                "valuation_methodology": "Grounded from comparable listings.",
                "valuation_comparable_prices_usd": [61000, 62500, 64000],
                "vehicle_sources": [{"title": "Comp 1", "url": "https://example.com/1"}],
                "vehicle_search_queries": ["2023 Audi RS e-tron GT used listings"],
                "grounding_status": "grounded",
            }
        ],
        "sources": [{"title": "Comp 1", "url": "https://example.com/1"}],
        "search_queries": ["2023 Audi RS e-tron GT used listings"],
        "claim_context": {
            "make": "Audi",
            "model": "RS e-tron GT",
            "trim": "Prestige",
            "year": 2023,
            "mileage": 24500,
            "pre_existing_damage": "",
        },
        "pricing_factors": ["Adjusted value down 12% for mileage."],
        "assessment_flags": [
            {
                "code": "repair_ratio_exceeds_threshold",
                "level": "high",
                "title": "Repair ratio exceeds threshold",
                "detail": "Estimated repairs are high relative to value.",
            }
        ],
        "completeness_checks": [
            {
                "code": "photo_coverage",
                "status": "missing",
                "title": "Photo coverage",
                "detail": "Only one photo was provided.",
            }
        ],
        "meta": {
            "segmentation_provider": "mock",
            "report_provider": "rules",
            "fallback_used": True,
            "image_count": 1,
            "grounding_status": "grounded",
            "generated_at": "2026-06-21T18:00:00Z",
        },
        "reviewed_regions": [
            {
                "part_id": "P1",
                "panel": "front bumper",
                "damage_type": "crack",
                "severity": "high",
                "confidence": 0.92,
                "bounding_box": {"x": 10, "y": 20, "width": 100, "height": 80},
                "estimated_repair_cost_usd": 10500,
                "source": "mock",
                "image_index": 0,
                "ai_assessor_model": "mock-model",
                "mask_png": "",
                "vehicle_value_usd": 62000,
                "vehicle_label": "Audi RS e-tron GT",
                "vehicle_total_loss": False,
                "total_loss_reason": "",
                "valuation_methodology": "Grounded from comparable listings.",
                "valuation_comparable_prices_usd": [61000, 62500, 64000],
                "vehicle_sources": [{"title": "Comp 1", "url": "https://example.com/1"}],
                "vehicle_search_queries": ["2023 Audi RS e-tron GT used listings"],
                "grounding_status": "grounded",
                "review_note": "Bumper replacement likely required.",
            }
        ],
        "review": {
            "claim_reference": "CLM-10248",
            "reviewer_name": "Alex Morgan",
            "final_action": "Review for total loss",
            "notes": "Needs supplement review.",
            "reviewed_total_cost_usd": 10500,
            "ai_recommended_action": "Escalate to adjuster for detailed review",
            "completed_at": "2026-06-21T18:10:00Z",
        },
    }


class InMemoryData:
    """Stands in for SupabaseData with a dict of rows.

    The repository no longer owns storage -- it reads and writes public.cases
    through the caller's token -- so the test substitutes the data layer
    rather than a database file. Ordering and the summary shaping are still
    exercised for real.
    """

    ready = True

    def __init__(self) -> None:
        self.rows: dict[str, dict] = {}

    def get_case(self, access_token, case_id):
        return self.rows.get(case_id)

    def insert_case(self, access_token, payload):
        self.rows[payload["id"]] = dict(payload)
        return self.rows[payload["id"]]

    def update_case(self, access_token, case_id, patch):
        if case_id not in self.rows:
            return None
        self.rows[case_id].update(patch)
        return self.rows[case_id]

    def list_cases_raw(self, access_token, *, columns="*", order="updated_at.desc", limit=25):
        rows = list(self.rows.values())
        if order.startswith("priority_score"):
            rows.sort(key=lambda r: r.get("priority_score", 0), reverse=True)
        return rows[:limit]


def test_case_api_round_trip_and_queue_order() -> None:
    original_repository = routes.case_repository
    original_verify = routes.supabase_auth.verify_bearer_token
    routes.case_repository = CaseRepository(InMemoryData())
    routes.supabase_auth.verify_bearer_token = _employee_token
    try:
        first_payload = _sample_case_payload()
        second_payload = deepcopy(first_payload)
        second_payload["review"]["claim_reference"] = "CLM-10249"
        second_payload["review"]["final_action"] = "Send to fast-track repair estimate"
        second_payload["assessment_flags"] = []
        second_payload["completeness_checks"] = []
        second_payload["overall_severity"] = "low"
        second_payload["repairability"] = "repair"

        save_response = client.post("/api/cases", json=first_payload)
        assert save_response.status_code == 200
        assert save_response.json()["queue_bucket"] == "urgent"

        save_response_two = client.post("/api/cases", json=second_payload)
        assert save_response_two.status_code == 200

        cases_response = client.get("/api/cases")
        assert cases_response.status_code == 200
        cases = cases_response.json()["cases"]
        assert len(cases) == 2

        queue_response = client.get("/api/queue")
        assert queue_response.status_code == 200
        queue_cases = queue_response.json()["cases"]
        assert queue_cases[0]["claim_reference"] == "CLM-10248"
        assert queue_cases[0]["priority_score"] >= queue_cases[1]["priority_score"]

        detail_response = client.get("/api/cases/CLM-10248")
        assert detail_response.status_code == 200
        detail = detail_response.json()
        assert detail["review"]["reviewer_name"] == "Alex Morgan"
        assert detail["reviewed_regions"][0]["review_note"] == "Bumper replacement likely required."
    finally:
        routes.case_repository = original_repository
        routes.supabase_auth.verify_bearer_token = original_verify


def test_case_api_rejects_unauthenticated_requests() -> None:
    original_verify = routes.supabase_auth.verify_bearer_token
    routes.supabase_auth.verify_bearer_token = lambda authorization: None
    try:
        assert client.get("/api/cases").status_code == 401
        assert client.get("/api/queue").status_code == 401
        assert client.get("/api/cases/CLM-10248").status_code == 401
        assert client.post("/api/cases", json=_sample_case_payload()).status_code == 401
    finally:
        routes.supabase_auth.verify_bearer_token = original_verify


def test_case_api_rejects_customer_role() -> None:
    original_verify = routes.supabase_auth.verify_bearer_token
    routes.supabase_auth.verify_bearer_token = lambda authorization: {
        "uid": "customer-1",
        "email": "customer@example.com",
        "role": "customer",
    }
    try:
        assert client.get("/api/cases").status_code == 403
        assert client.get("/api/queue").status_code == 403
    finally:
        routes.supabase_auth.verify_bearer_token = original_verify
