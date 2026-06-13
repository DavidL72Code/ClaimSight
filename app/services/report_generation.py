from app.models.schemas import AssessmentMeta, AssessmentResponse, DamageRegion
from app.services.gemini_client import GeminiClaimNarrator


class ClaimReportService:
    def __init__(self) -> None:
        self._narrator = GeminiClaimNarrator()

    def build_assessment(
        self,
        filenames: list[str],
        image_paths: list,
        regions: list[DamageRegion],
        segmentation_provider: str,
    ) -> AssessmentResponse:
        total_cost = sum(region.estimated_repair_cost_usd for region in regions)
        high_count = sum(region.severity == "high" for region in regions)
        overall_severity = "high" if high_count else "moderate" if total_cost >= 1000 else "low"
        repairability = "repair" if total_cost < 5000 else "review for total loss"
        recommended_action = (
            "Send to fast-track repair estimate"
            if overall_severity in {"low", "moderate"}
            else "Escalate to adjuster for detailed review"
        )

        fallback_summary = self._build_summary(regions, total_cost, overall_severity)
        summary = (
            self._narrator.build_summary(image_paths, filenames, regions) or fallback_summary
        )
        fallback_used = summary == fallback_summary

        return AssessmentResponse(
            filename=filenames[0] if filenames else "",
            filenames=filenames,
            vehicle_type="passenger vehicle",
            overall_severity=overall_severity,
            repairability=repairability,
            estimated_total_cost_usd=total_cost,
            recommended_action=recommended_action,
            summary=summary,
            regions=regions,
            meta=AssessmentMeta(
                segmentation_provider=segmentation_provider,
                report_provider=self._narrator.provider_name,
                fallback_used=fallback_used,
                image_count=len(image_paths),
            ),
        )

    def _build_summary(
        self,
        regions: list[DamageRegion],
        total_cost: int,
        overall_severity: str,
    ) -> str:
        if not regions:
            return (
                "No vehicle damage was detected in the submitted image(s). "
                "If damage is expected, capture clearer or additional angles."
            )
        region_descriptions = ", ".join(
            f"{region.severity} {region.damage_type} on the {region.panel}" for region in regions
        )
        return (
            f"The submitted image(s) suggest {region_descriptions}. "
            f"Estimated repair exposure is about ${total_cost}, with an overall severity of {overall_severity}."
        )
