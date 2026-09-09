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


# A low-severity ("cosmetic") finding below this confidence is dropped
# rather than priced. Chosen from observed behaviour, not taste: across the
# fixture set every genuine finding came back at 0.92-0.99, while the two
# fabricated findings on an undamaged press photo came back at 0.75 and
# 0.78. The gap is wide and consistent, so the floor sits inside it.
#
# Only cosmetic findings are filtered. High/moderate severity findings are
# never dropped on confidence: a hedged call about structural damage is
# exactly the kind of thing an adjuster must still see.
COSMETIC_CONFIDENCE_FLOOR = 0.85

# No single bolt-on panel should cost this share of the whole vehicle. Taken
# from the audit: a Megane hood came back at 50% of ACV and an Escort door at
# 70%, which no adjuster would sign. Those numbers come from pricing generic
# body-shop labour without reference to what the car is worth.
#
# Structural work is deliberately exempt — a bent frame rail genuinely can
# cost most of a cheap car's value, and that is precisely the signal that
# should drive a total loss rather than be capped away.
PANEL_COST_CAP_RATIO = 0.35

STRUCTURAL_PANEL_TERMS = (
    "frame", "rail", "pillar", "unibody", "chassis", "radiator support",
    "subframe", "apron", "firewall", "structural", "crossmember", "front end",
)


# Labels that lump several parts into one line. An estimate built from these
# cannot be ordered against, so they are reported rather than accepted
# silently -- the audit found a single "front end - $6,000" region standing in
# for bumper, hood, both fenders, grille, rad support, frame and suspension.
AGGREGATE_PANEL_TERMS = (
    "front end", "rear end", "front clip", "rear clip", "whole vehicle",
    "entire vehicle", "body", "side panel", "front section", "rear section",
    "multiple panels", "various",
)


def _is_aggregate(region) -> bool:
    panel = (region.panel or "").strip().lower()
    return any(panel == term or panel.startswith(term) for term in AGGREGATE_PANEL_TERMS)


def _is_structural(region) -> bool:
    text = f"{region.panel} {region.damage_type}".lower()
    return any(term in text for term in STRUCTURAL_PANEL_TERMS)


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

        # Drop unconvincing cosmetic findings before anything is priced.
        discarded_cosmetic = [
            region for region in regions
            if region.severity == "low" and (region.confidence or 0) < COSMETIC_CONFIDENCE_FLOOR
        ]
        if discarded_cosmetic:
            regions = [region for region in regions if region not in discarded_cosmetic]

        # Cap implausible per-panel prices against the vehicle's own value.
        # Done before totalling so the total-loss ratio is computed from
        # defensible numbers rather than inflated ones.
        capped_panels: list[tuple[str, int, int]] = []
        uncapped_total = sum(region.estimated_repair_cost_usd for region in regions)
        declared_value = max((region.vehicle_value_usd for region in regions), default=0)
        if declared_value > 0:
            cap = int(PANEL_COST_CAP_RATIO * declared_value)
            for region in regions:
                if _is_structural(region):
                    continue
                if region.estimated_repair_cost_usd > cap:
                    capped_panels.append(
                        (region.panel, region.estimated_repair_cost_usd, cap)
                    )
                    region.estimated_repair_cost_usd = cap

        total_cost = sum(region.estimated_repair_cost_usd for region in regions)
        high_count = sum(region.severity == "high" for region in regions)
        moderate_count = sum(region.severity == "moderate" for region in regions)

        # Severity follows the parts, not the bill. The old rule was
        # `"moderate" if total_cost >= 1000` — so two findings the detector
        # itself called "low" became a moderate-severity claim purely because
        # they summed past $1,000, which is trivially crossed on any modern
        # vehicle.
        if high_count:
            overall_severity = "high"
        elif moderate_count:
            overall_severity = "moderate"
        else:
            overall_severity = "low"

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
        #
        # With no valuation the ratio is not computable, and the flat $5,000
        # threshold that used to stand in for it is not a decision — it is a
        # guess that happens to be right on expensive cars and wrong on cheap
        # ones. A $2,000 car with $4,000 of damage is a write-off, and that
        # rule called it a repair. So when value is unknown the ratio abstains
        # and the claim is escalated instead of being settled on a number
        # nobody can defend.
        total_loss_ratio = 0.75
        value_known = adjusted_vehicle_value > 0
        ratio_total_loss = (
            total_cost >= total_loss_ratio * adjusted_vehicle_value if value_known else False
        )
        total_loss_undecidable = bool(regions) and not value_known

        # The cap is a ceiling, not a real quote. If the write-off decision
        # flips only because prices were capped, the honest answer is that the
        # decision is sensitive to pricing — so keep the write-off (never deny
        # one on the strength of a ceiling) and put it in front of a human.
        ratio_uncapped = (
            uncapped_total >= total_loss_ratio * adjusted_vehicle_value if value_known else False
        )
        pricing_sensitive = value_known and ratio_uncapped != ratio_total_loss

        is_total_loss = ai_total_loss or ratio_total_loss or ratio_uncapped
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
            discarded_cosmetic=discarded_cosmetic,
            total_loss_undecidable=total_loss_undecidable,
            capped_panels=capped_panels,
            pricing_sensitive=pricing_sensitive,
            aggregate_regions=[r for r in regions if _is_aggregate(r)],
        )
        completeness_checks = self._build_completeness_checks(
            image_count=len(image_paths),
            claim_context=claim_context,
        )

        # No damage found is a real outcome and needs to route somewhere other
        # than "fast-track repair estimate", which is what a zero-region
        # assessment used to produce.
        if not regions:
            recommended_action = "No damage detected — confirm the correct photos were submitted"
        elif total_loss_undecidable:
            recommended_action = "Escalate to adjuster: set vehicle value before deciding repair vs total loss"
        elif pricing_sensitive:
            recommended_action = "Escalate to adjuster: confirm panel pricing before settling"
        elif claim_context.pre_existing_damage and not is_total_loss:
            recommended_action = "Route to adjuster to separate prior damage from this loss"
        elif is_total_loss:
            # "Escalate to adjuster for detailed review" was the old catch-all
            # here, which told the adjuster nothing on the most consequential
            # outcome the system produces. State the call and its basis.
            recommended_action = (
                f"Total loss — settle at vehicle value ${adjusted_vehicle_value:,} "
                f"(repair ${total_cost:,} exceeds value); confirm ACV and salvage"
                if adjusted_vehicle_value
                else f"Total loss — repair ${total_cost:,} is uneconomic; confirm ACV before settling"
            )
        elif any(_is_structural(r) for r in regions):
            structural = ", ".join(
                sorted({str(getattr(r, "panel", "") or "").strip()
                        for r in regions if _is_structural(r)} - {""})
            )
            recommended_action = (
                f"Authorise teardown inspection before repair — structural damage to {structural}"
                if structural
                else "Authorise teardown inspection before repair — structural damage detected"
            )
        elif overall_severity in {"low", "moderate"}:
            recommended_action = f"Send to fast-track repair estimate — approve ${total_cost:,} repair"
        else:
            recommended_action = (
                f"Adjuster review before authorising — {len(regions)} damaged area(s), "
                f"${total_cost:,} repair with high-severity findings"
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
        discarded_cosmetic: list[DamageRegion] | None = None,
        total_loss_undecidable: bool = False,
        capped_panels: list[tuple[str, int, int]] | None = None,
        pricing_sensitive: bool = False,
        aggregate_regions: list[DamageRegion] | None = None,
    ) -> list[AssessmentFlag]:
        flags: list[AssessmentFlag] = []

        # A dropped finding must never be silent — the adjuster should be able
        # to see that something was proposed and rejected, and on what basis.
        for region in discarded_cosmetic or []:
            flags.append(AssessmentFlag(
                code="low_confidence_cosmetic_discarded",
                level="info",
                title="Unconvincing cosmetic finding dropped",
                detail=(
                    f"{region.panel or 'A panel'} was reported as {region.damage_type or 'cosmetic damage'} "
                    f"at {region.confidence:.2f} confidence, below the {COSMETIC_CONFIDENCE_FLOOR:.2f} "
                    "floor for cosmetic findings, so it was not priced."
                ),
            ))

        for panel, original, cap in capped_panels or []:
            flags.append(AssessmentFlag(
                code="panel_cost_capped",
                level="warning",
                title="Panel estimate capped against vehicle value",
                detail=(
                    f"{panel or 'A panel'} was estimated at ${original:,}, more than "
                    f"{PANEL_COST_CAP_RATIO:.0%} of the vehicle's ${cap / PANEL_COST_CAP_RATIO:,.0f} "
                    f"value; reduced to ${cap:,} for the total. Confirm against a parts quote."
                ),
            ))

        for region in aggregate_regions or []:
            flags.append(AssessmentFlag(
                code="aggregate_region_not_itemised",
                level="warning",
                title="Estimate line covers several parts at once",
                detail=(
                    f"\"{region.panel}\" was priced as a single ${region.estimated_repair_cost_usd:,} "
                    "line rather than itemised parts. An adjuster cannot order against this — "
                    "request a per-panel breakdown before settling."
                ),
            ))

        if pricing_sensitive:
            flags.append(AssessmentFlag(
                code="total_loss_sensitive_to_pricing",
                level="high",
                title="Write-off decision turns on capped pricing",
                detail=(
                    "Repair cost sits either side of the total-loss threshold depending on whether "
                    "the capped or the original panel estimates are used. Treated as a total loss "
                    "pending a real parts quote."
                ),
            ))

        if total_loss_undecidable:
            flags.append(AssessmentFlag(
                code="total_loss_undecidable_without_value",
                level="high",
                title="Total loss cannot be decided without a valuation",
                detail=(
                    "No market value could be established, so repair cost could not be weighed "
                    "against the vehicle's worth. A human must set the value before this claim "
                    "is settled either way."
                ),
            ))

        if not regions:
            flags.append(AssessmentFlag(
                code="no_damage_detected",
                level="info",
                title="No damage detected",
                detail="No visible damage was found. Confirm the submitted photos show the damaged vehicle.",
            ))
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

        # ── consistency checks that do NOT depend on model confidence ──
        # The model reported 0.95-0.99 confidence on an assessment that omitted
        # all structural work and accepted a wrong model year, so self-reported
        # confidence cannot be the only gate.

        # A near-tie between repair and value means the repair/total-loss call
        # rests on two estimates being right to within a few percent.
        if adjusted_vehicle_value > 0 and total_cost > 0:
            margin = abs(total_cost - adjusted_vehicle_value) / adjusted_vehicle_value
            if margin <= 0.10:
                flags.append(
                    AssessmentFlag(
                        code="total_loss_margin_thin",
                        level="high",
                        title="Repair and value are too close to call",
                        detail=(
                            f"Estimated repairs (${total_cost:,}) are within {margin:.0%} of "
                            f"vehicle value (${adjusted_vehicle_value:,}), so a small revision to "
                            "either figure would flip the repair-versus-total-loss outcome."
                        ),
                    )
                )

        # Several panels called "high" with no structural line item usually means
        # the estimate covers visible panels only.
        high_regions = [r for r in regions if r.severity == "high"]
        structural_terms = (
            "frame", "rail", "pillar", "unibody", "chassis", "radiator support",
            "subframe", "apron", "firewall", "structural", "crossmember",
        )
        has_structural = any(
            any(term in f"{r.panel} {r.damage_type}".lower() for term in structural_terms)
            for r in regions
        )
        if len(high_regions) >= 3 and not has_structural:
            flags.append(
                AssessmentFlag(
                    code="possible_underscoped_structural",
                    level="warning",
                    title="Structural damage may be unpriced",
                    detail=(
                        f"{len(high_regions)} panels are rated high severity but no structural "
                        "component (frame, rail, pillar, radiator support) is priced. Impacts "
                        "severe enough to destroy this many panels usually deform structure."
                    ),
                )
            )

        # The claimant's year versus what the model can actually see.
        detected_year = next(
            (r.vehicle_year_detected for r in regions if r.vehicle_year_detected), 0
        )
        if detected_year and claim_context.year and abs(detected_year - claim_context.year) > 1:
            flags.append(
                AssessmentFlag(
                    code="vehicle_identity_conflict",
                    level="warning",
                    title="Reported year disagrees with the photos",
                    detail=(
                        f"The claim reports {claim_context.year} but the images look like "
                        f"{detected_year}. Vehicle value depends on this, so confirm the year "
                        "against the VIN or registration."
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
