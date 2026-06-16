from datetime import datetime

from app.models.schemas import AssessmentMeta, AssessmentResponse, ClaimContext, DamageRegion
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
            meta=AssessmentMeta(
                segmentation_provider=segmentation_provider,
                report_provider=self._narrator.provider_name,
                fallback_used=fallback_used,
                image_count=len(image_paths),
                grounding_status=grounding_status,
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

    def _resolve_vehicle_label(self, detected_label: str, claim_context: ClaimContext) -> str:
        detected_parts = detected_label.split()

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
        if claim_context.year and detected_label:
            return f"{claim_context.year} {detected_label}"
        if claim_context.year:
            return f"{claim_context.year} passenger vehicle"
        return detected_label or "passenger vehicle"

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
