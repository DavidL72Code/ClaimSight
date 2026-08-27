from __future__ import annotations

from datetime import datetime, timezone
import re

from app.models.schemas import (
    AssessmentFlag,
    AssessmentMeta,
    AssessmentResponse,
    ClaimContext,
    CompletenessCheck,
    DamageRegion,
)
from app.services.gemini_client import GeminiClaimNarrator

_YEAR_PREFIX_PATTERN = re.compile(r"^\d{4}\s+")


class ClaimReportService:
    def __init__(self) -> None:
        self._narrator = GeminiClaimNarrator()

    def build_assessment(
        self,
        filenames: list[str],
        image_paths: list,
        regions: list[DamageRegion],
        segmentation_provider: str,
        claim_context: ClaimContext | None = None,
    ) -> AssessmentResponse:
        claim_context = claim_context or ClaimContext()
        total_cost = sum(region.estimated_repair_cost_usd for region in regions)
        high_count = sum(region.severity == "high" for region in regions)
        overall_severity = "high" if high_count else "moderate" if total_cost >= 1000 else "low"

        # Vehicle value comes from the detector (same across a vehicle's regions).
        vehicle_value = max((region.vehicle_value_usd for region in regions), default=0)
        vehicle_label = next(
            (region.vehicle_label for region in regions if region.vehicle_label), ""
        )
        resolved_vehicle_label = self._resolve_vehicle_label(vehicle_label, claim_context)
        # The detector's holistic total-loss verdict (catches structural/unrepairable
        # cases the cost-vs-value ratio alone would miss).
        ai_total_loss = any(region.vehicle_total_loss for region in regions)
        total_loss_reason = next(
            (region.total_loss_reason for region in regions if region.total_loss_reason), ""
        )
        valuation_methodology = next(
            (region.valuation_methodology for region in regions if region.valuation_methodology),
            "",
        )
        valuation_comparable_prices = next(
            (
                region.valuation_comparable_prices_usd
                for region in regions
                if region.valuation_comparable_prices_usd
            ),
            [],
        )
        sources = next((region.vehicle_sources for region in regions if region.vehicle_sources), [])
        search_queries = next(
            (region.vehicle_search_queries for region in regions if region.vehicle_search_queries),
            [],
        )
        grounding_status = next(
            (region.grounding_status for region in regions if region.grounding_status), ""
        )
        adjusted_vehicle_value, pricing_factors = self._adjust_vehicle_value(
            vehicle_value,
            claim_context,
        )

        # Total-loss when EITHER the model flags it OR repairs exceed ~75% of ACV.
        # When value is unknown (classical fallback), fall back to a flat threshold.
        total_loss_ratio = 0.75
        if adjusted_vehicle_value > 0:
            ratio_total_loss = total_cost >= total_loss_ratio * adjusted_vehicle_value
        else:
            ratio_total_loss = total_cost >= 5000
        is_total_loss = ai_total_loss or ratio_total_loss
        repairability = "review for total loss" if is_total_loss else "repair"
        assessment_flags = self._build_assessment_flags(
            regions=regions,
            image_count=len(image_paths),
            claim_context=claim_context,
            adjusted_vehicle_value=adjusted_vehicle_value,
            total_cost=total_cost,
            sources_count=len(sources),
            comparable_count=len(valuation_comparable_prices),
            grounding_status=grounding_status,
            ai_total_loss=ai_total_loss,
            ratio_total_loss=ratio_total_loss,
        )
        completeness_checks = self._build_completeness_checks(
            image_count=len(image_paths),
            claim_context=claim_context,
        )

        if claim_context.pre_existing_damage and not is_total_loss:
            recommended_action = "Route to adjuster to separate prior damage from this loss"
        else:
            recommended_action = (
                "Send to fast-track repair estimate"
                if overall_severity in {"low", "moderate"} and not is_total_loss
                else "Escalate to adjuster for detailed review"
            )

        fallback_summary = self._build_summary(
            regions,
            total_cost,
            overall_severity,
            resolved_vehicle_label,
            adjusted_vehicle_value,
            claim_context,
            pricing_factors,
        )
        summary = (
            self._narrator.build_summary(
                image_paths,
                filenames,
                regions,
                claim_context,
                pricing_factors,
                resolved_vehicle_label,
                adjusted_vehicle_value,
            )
            or fallback_summary
        )
        fallback_used = summary == fallback_summary

        return AssessmentResponse(
            filename=filenames[0] if filenames else "",
            filenames=filenames,
            vehicle_type=resolved_vehicle_label or "passenger vehicle",
            estimated_vehicle_value_usd=adjusted_vehicle_value,
            valuation_methodology=valuation_methodology,
            valuation_comparable_prices_usd=valuation_comparable_prices,
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
            claim_context=claim_context,
            pricing_factors=pricing_factors,
            assessment_flags=assessment_flags,
            completeness_checks=completeness_checks,
            meta=AssessmentMeta(
                segmentation_provider=segmentation_provider,
                report_provider=self._narrator.provider_name,
                fallback_used=fallback_used,
                image_count=len(image_paths),
                grounding_status=grounding_status,
                generated_at=datetime.now(timezone.utc)
                .replace(microsecond=0, tzinfo=None)
                .isoformat()
                + "Z",
            ),
        )

    def _build_summary(
        self,
        regions: list[DamageRegion],
        total_cost: int,
        overall_severity: str,
        vehicle_label: str,
        adjusted_vehicle_value: int,
        claim_context: ClaimContext,
        pricing_factors: list[str],
    ) -> str:
        if not regions:
            return (
                "No vehicle damage was detected in the submitted image(s). "
                "If damage is expected, capture clearer or additional angles."
            )
        region_descriptions = ", ".join(
            f"{region.severity} {region.damage_type} on the {region.panel}" for region in regions
        )
        pricing_sentence = ""
        if adjusted_vehicle_value > 0:
            pricing_sentence = f" Contextualized vehicle value is about ${adjusted_vehicle_value:,}."
        if pricing_factors:
            pricing_sentence += f" Pricing factors considered: {'; '.join(pricing_factors)}."
        if claim_context.pre_existing_damage:
            pricing_sentence += " Reported pre-accident damage should be separated from this loss during review."
        return (
            f"The submitted image(s) suggest {region_descriptions} on the {vehicle_label or 'vehicle'}. "
            f"Estimated repair exposure is about ${total_cost:,}, with an overall severity of {overall_severity}."
            f"{pricing_sentence}"
        )

    def _build_assessment_flags(
        self,
        *,
        regions: list[DamageRegion],
        image_count: int,
        claim_context: ClaimContext,
        adjusted_vehicle_value: int,
        total_cost: int,
        sources_count: int,
        comparable_count: int,
        grounding_status: str,
        ai_total_loss: bool,
        ratio_total_loss: bool,
    ) -> list[AssessmentFlag]:
        flags: list[AssessmentFlag] = []
        low_confidence_regions = [region for region in regions if region.confidence < 0.65]
        if low_confidence_regions:
            weakest_region = min(low_confidence_regions, key=lambda region: region.confidence)
            flags.append(
                AssessmentFlag(
                    code="low_visual_confidence",
                    level="warning",
                    title="Low visual confidence",
                    detail=(
                        f"At least one detected part scored below 65% confidence. "
                        f"Weakest region: {weakest_region.panel} at {weakest_region.confidence:.0%}."
                    ),
                )
            )

        if image_count < 3:
            flags.append(
                AssessmentFlag(
                    code="limited_photo_set",
                    level="warning",
                    title="Limited photo set",
                    detail=(
                        "The assessment used fewer than three photos, so hidden or opposite-side "
                        "damage may not be represented."
                    ),
                )
            )

        if adjusted_vehicle_value <= 0:
            flags.append(
                AssessmentFlag(
                    code="value_not_grounded",
                    level="warning",
                    title="Vehicle value needs review",
                    detail=(
                        "The app could not produce a confident vehicle value, which makes repair-versus-"
                        "total-loss guidance less reliable."
                    ),
                )
            )

        if sources_count == 0 or comparable_count == 0:
            grounding_detail = (
                f"Grounding status: {grounding_status}." if grounding_status else
                "No comparable sources were attached to this assessment."
            )
            flags.append(
                AssessmentFlag(
                    code="weak_market_grounding",
                    level="warning",
                    title="Market evidence is thin",
                    detail=(
                        "Vehicle valuation should be reviewed against live market comps. "
                        f"{grounding_detail}"
                    ),
                )
            )

        if adjusted_vehicle_value > 0:
            repair_ratio = total_cost / adjusted_vehicle_value
            if 0.6 <= repair_ratio < 0.75 and not ratio_total_loss:
                flags.append(
                    AssessmentFlag(
                        code="near_total_loss_threshold",
                        level="warning",
                        title="Near total-loss threshold",
                        detail=(
                            f"Estimated repairs are about {repair_ratio:.0%} of vehicle value, so "
                            "supplements or hidden damage could change the outcome."
                        ),
                    )
                )
            elif repair_ratio >= 0.75:
                flags.append(
                    AssessmentFlag(
                        code="repair_ratio_exceeds_threshold",
                        level="high",
                        title="Repair ratio exceeds threshold",
                        detail=(
                            f"Estimated repairs are about {repair_ratio:.0%} of vehicle value, "
                            "which supports total-loss review."
                        ),
                    )
                )

        if ai_total_loss:
            flags.append(
                AssessmentFlag(
                    code="ai_total_loss_signal",
                    level="high",
                    title="AI flagged possible total loss",
                    detail=(
                        "The vision model marked the vehicle as a potential structural or economic "
                        "total loss. Human review is recommended."
                    ),
                )
            )

        if claim_context.pre_existing_damage:
            flags.append(
                AssessmentFlag(
                    code="prior_damage_reported",
                    level="info",
                    title="Pre-existing damage reported",
                    detail=(
                        "The claimant reported prior damage, so the current loss should be separated "
                        "from pre-accident condition during review."
                    ),
                )
            )

        return flags

    def _build_completeness_checks(
        self,
        *,
        image_count: int,
        claim_context: ClaimContext,
    ) -> list[CompletenessCheck]:
        checks: list[CompletenessCheck] = []

        photo_status = "complete" if image_count >= 3 else "partial" if image_count == 2 else "missing"
        photo_detail = (
            "Three or more photos were provided, which is enough for a basic multi-angle review."
            if photo_status == "complete"
            else "Two photos were provided. Add at least one more angle for better damage coverage."
            if photo_status == "partial"
            else "Only one photo was provided. Add front, rear, and side angles before relying on the estimate."
        )
        checks.append(
            CompletenessCheck(
                code="photo_coverage",
                status=photo_status,
                title="Photo coverage",
                detail=photo_detail,
            )
        )

        has_identity = bool(claim_context.make and claim_context.model and claim_context.year)
        partial_identity = any([claim_context.make, claim_context.model, claim_context.year])
        identity_status = "complete" if has_identity else "partial" if partial_identity else "missing"
        checks.append(
            CompletenessCheck(
                code="vehicle_identity",
                status=identity_status,
                title="Vehicle identity",
                detail=(
                    "Make, model, and year were supplied."
                    if identity_status == "complete"
                    else "Some vehicle details were supplied, but not enough to fully identify the vehicle."
                    if identity_status == "partial"
                    else "Add make, model, and year to improve valuation accuracy."
                ),
            )
        )

        checks.append(
            CompletenessCheck(
                code="mileage",
                status="complete" if claim_context.mileage is not None else "missing",
                title="Mileage",
                detail=(
                    f"Reported mileage: {claim_context.mileage:,} miles."
                    if claim_context.mileage is not None
                    else "Mileage is missing. Add odometer mileage to improve pricing adjustments."
                ),
            )
        )

        checks.append(
            CompletenessCheck(
                code="prior_damage_history",
                status="complete" if claim_context.pre_existing_damage else "partial",
                title="Prior damage history",
                detail=(
                    "Prior damage notes were included."
                    if claim_context.pre_existing_damage
                    else "No prior damage notes were supplied. Confirm whether any pre-existing damage is known."
                ),
            )
        )

        return checks

    def _resolve_vehicle_label(self, detected_label: str, claim_context: ClaimContext) -> str:
        stripped_detected_label = _YEAR_PREFIX_PATTERN.sub("", detected_label.strip(), count=1)
        detected_parts = stripped_detected_label.split()

        make = claim_context.make.strip()
        model = claim_context.model.strip()
        trim = claim_context.trim.strip()

        if not make and detected_parts:
            make = detected_parts[0]
        if not model and len(detected_parts) > 1:
            model = " ".join(detected_parts[1:])

        label_parts = [make, model, trim]
        core_label = " ".join(part for part in label_parts if part).strip()

        if claim_context.year and core_label:
            return f"{claim_context.year} {core_label}"
        if core_label:
            return core_label
        if claim_context.year and stripped_detected_label:
            return f"{claim_context.year} {stripped_detected_label}"
        if claim_context.year:
            return f"{claim_context.year} passenger vehicle"
        return stripped_detected_label or "passenger vehicle"

    def _adjust_vehicle_value(
        self,
        base_value: int,
        claim_context: ClaimContext,
    ) -> tuple[int, list[str]]:
        pricing_factors: list[str] = []
        if base_value <= 0:
            if any(
                [
                    claim_context.year,
                    claim_context.mileage is not None,
                    bool(claim_context.pre_existing_damage),
                ]
            ):
                pricing_factors.append(
                    "Vehicle details were captured, but market value could not be adjusted because no base valuation was available."
                )
            return 0, pricing_factors

        adjusted_value = float(base_value)
        current_year = datetime.now().year

        if claim_context.year:
            age = max(current_year - claim_context.year, 0)
            age_factor = 1.0
            if age >= 12:
                age_factor = 0.78
            elif age >= 8:
                age_factor = 0.86
            elif age >= 5:
                age_factor = 0.93
            elif age <= 1:
                age_factor = 1.03
            if age_factor != 1.0:
                adjusted_value *= age_factor
                direction = "down" if age_factor < 1 else "up"
                percent = abs(round((1 - age_factor) * 100))
                pricing_factors.append(
                    f"Adjusted value {direction} {percent}% for model year {claim_context.year}."
                )

        if claim_context.mileage is not None:
            mileage_factor = 1.0
            if claim_context.mileage >= 150000:
                mileage_factor = 0.78
            elif claim_context.mileage >= 100000:
                mileage_factor = 0.88
            elif claim_context.mileage >= 75000:
                mileage_factor = 0.94
            elif claim_context.mileage <= 30000:
                mileage_factor = 1.04
            if mileage_factor != 1.0:
                adjusted_value *= mileage_factor
                direction = "down" if mileage_factor < 1 else "up"
                percent = abs(round((1 - mileage_factor) * 100))
                pricing_factors.append(
                    f"Adjusted value {direction} {percent}% for reported mileage of {claim_context.mileage:,}."
                )

        if claim_context.pre_existing_damage:
            adjusted_value *= 0.9
            pricing_factors.append(
                "Adjusted value down 10% for reported pre-existing damage."
            )

        return max(0, round(adjusted_value)), pricing_factors
