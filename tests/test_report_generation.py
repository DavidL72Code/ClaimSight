from app.models.schemas import BoundingBox, ClaimContext, DamageRegion
from app.services.report_generation import ClaimReportService


def test_build_assessment_uses_vehicle_context_for_pricing() -> None:
    service = ClaimReportService()
    regions = [
        DamageRegion(
            part_id="P1",
            panel="front bumper",
            damage_type="dent",
            severity="moderate",
            confidence=0.94,
            bounding_box=BoundingBox(x=10, y=20, width=120, height=80),
            estimated_repair_cost_usd=4200,
            source="mock",
            vehicle_value_usd=20000,
            vehicle_label="Audi RS e-tron GT",
        )
    ]

    response = service.build_assessment(
        filenames=["claim.jpg"],
        image_paths=[],
        regions=regions,
        segmentation_provider="mock",
        claim_context=ClaimContext(
            make="Audi",
            model="RS e-tron GT",
            trim="Prestige",
            year=2021,
            mileage=118000,
            pre_existing_damage="Minor rear bumper scuffs",
        ),
    )

    assert response.vehicle_type == "2021 Audi RS e-tron GT Prestige"
    assert response.claim_context.mileage == 118000
    assert response.estimated_vehicle_value_usd < 20000
    assert any("mileage" in factor.lower() for factor in response.pricing_factors)
    assert "pre-accident damage" in response.summary.lower()


def test_build_assessment_handles_partial_vehicle_details() -> None:
    service = ClaimReportService()
    regions = [
        DamageRegion(
            part_id="P1",
            panel="front bumper",
            damage_type="dent",
            severity="moderate",
            confidence=0.94,
            bounding_box=BoundingBox(x=10, y=20, width=120, height=80),
            estimated_repair_cost_usd=1800,
            source="mock",
            vehicle_value_usd=16000,
            vehicle_label="Audi RS e-tron GT",
        )
    ]

    response = service.build_assessment(
        filenames=["claim.jpg"],
        image_paths=[],
        regions=regions,
        segmentation_provider="mock",
        claim_context=ClaimContext(
            year=2023,
            mileage=28000,
        ),
    )

    assert response.vehicle_type == "2023 Audi RS e-tron GT"
    assert any("2023" in factor for factor in response.pricing_factors) or response.estimated_vehicle_value_usd > 0
