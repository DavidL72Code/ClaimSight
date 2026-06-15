from app.models.schemas import ClaimContext, DamageRegion
from app.services.gemini_client import GeminiClaimNarrator


def test_build_comparable_query_uses_claim_details() -> None:
    narrator = GeminiClaimNarrator()
    context = ClaimContext(
        make="Audi",
        model="RS e-tron GT",
        trim="Prestige",
        year=2023,
        mileage=24500,
    )

    label = narrator._resolve_listing_label([], context)
    query = narrator._build_comparable_query(label, context)

    assert label == "2023 Audi RS e-tron GT Prestige"
    assert "24500 miles" in query
    assert "model year 2023" in query
    assert "comparable used listings" in query
    assert "market value" in query


def test_resolve_listing_label_falls_back_to_detected_vehicle() -> None:
    narrator = GeminiClaimNarrator()
    detected = [
        DamageRegion(
            panel="front bumper",
            damage_type="dent",
            severity="moderate",
            confidence=0.8,
            bounding_box={"x": 0, "y": 0, "width": 1, "height": 1},
            estimated_repair_cost_usd=1000,
            source="mock",
            vehicle_label="Audi RS e-tron GT",
        )
    ]

    label = narrator._resolve_listing_label(detected, ClaimContext())

    assert label == "Audi RS e-tron GT"


def test_resolve_listing_label_blends_partial_claim_details_with_detected_vehicle() -> None:
    narrator = GeminiClaimNarrator()
    detected = [
        DamageRegion(
            panel="front bumper",
            damage_type="dent",
            severity="moderate",
            confidence=0.8,
            bounding_box={"x": 0, "y": 0, "width": 1, "height": 1},
            estimated_repair_cost_usd=1000,
            source="mock",
            vehicle_label="Audi RS e-tron GT",
        )
    ]

    label = narrator._resolve_listing_label(
        detected,
        ClaimContext(year=2023, trim="Prestige"),
    )

    assert label == "2023 Audi RS e-tron GT Prestige"
