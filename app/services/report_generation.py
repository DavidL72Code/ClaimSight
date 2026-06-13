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

        # Vehicle value comes from the detector (same across a vehicle's regions).
        vehicle_value = max((region.vehicle_value_usd for region in regions), default=0)
        vehicle_label = next(
            (region.vehicle_label for region in regions if region.vehicle_label), ""
        )
        # The detector's holistic total-loss verdict (catches structural/unrepairable
        # cases the cost-vs-value ratio alone would miss).
        ai_total_loss = any(region.vehicle_total_loss for region in regions)
        total_loss_reason = next(
            (region.total_loss_reason for region in regions if region.total_loss_reason), ""
        )
        sources = next((region.vehicle_sources for region in regions if region.vehicle_sources), [])
        search_queries = next(
            (region.vehicle_search_queries for region in regions if region.vehicle_search_queries),
            [],
        )

        # Total-loss when EITHER the model flags it OR repairs exceed ~75% of ACV.
        # When value is unknown (classical fallback), fall back to a flat threshold.
        total_loss_ratio = 0.75
        if vehicle_value > 0:
            ratio_total_loss = total_cost >= total_loss_ratio * vehicle_value
        else:
            ratio_total_loss = total_cost >= 5000
        is_total_loss = ai_total_loss or ratio_total_loss
        repairability = "review for total loss" if is_total_loss else "repair"

        recommended_action = (
            "Send to fast-track repair estimate"
            if overall_severity in {"low", "moderate"} and not is_total_loss
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
            vehicle_type=vehicle_label or "passenger vehicle",
            estimated_vehicle_value_usd=vehicle_value,
            total_loss=is_total_loss,
            total_loss_reason=total_loss_reason,
            overall_severity=overall_severity,
            repairability=repairability,
            estimated_total_cost_usd=total_cost,
            recommended_action=recommended_action,
            summary=summary,
            regions=regions,
            sources=sources,
            search_queries=search_queries,
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
