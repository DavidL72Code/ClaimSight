"""Assessment orchestration: detect -> self-correct -> grade.

The pipeline is deliberately bounded. Each assessment runs at most
MAX_ASSESSMENT_RETRIES self-correction passes, and a retry re-runs only the one
stage that was judged weak rather than the whole thing, so worst-case latency
and spend stay predictable.

A retry is kept only if it actually resolves the flag that triggered it.
Otherwise the original result is restored, because a second model call is not
automatically a better one and a silent regression is worse than a known gap.
"""

from __future__ import annotations

import copy
import logging

from app.core.config import ENABLE_ASSESSMENT_RETRY, MAX_ASSESSMENT_RETRIES
from app.models.schemas import AssessmentResponse, ClaimContext, RetryAttempt

logger = logging.getLogger("claimsight.pipeline")

# Flags worth spending another model call on, mapped to the stage that can fix
# them and the guidance handed back to the model. Flags absent from this table
# (for example limited_photo_set) are NOT retryable: no amount of re-prompting
# invents a photo the claimant never uploaded.
RETRYABLE_FLAGS: dict[str, tuple[str, str]] = {
    "low_visual_confidence": (
        "detection",
        "Damage regions were detected with low confidence. Look again more carefully, "
        "and only report parts you can actually see damage on.",
    ),
    "value_not_grounded": (
        "valuation",
        "No defensible vehicle value was produced. Search for real comparable listings "
        "for this specific vehicle and base the value on them.",
    ),
    "weak_market_grounding": (
        "valuation",
        "The vehicle value was not backed by comparable market listings. Find real "
        "comparable listings and cite them.",
    ),
}

# Highest-value stage first: a bad valuation distorts the total-loss call, which
# is the decision the adjuster actually acts on.
_FLAG_PRIORITY = ("value_not_grounded", "weak_market_grounding", "low_visual_confidence")


class AssessmentPipeline:
    def __init__(self, segmentation_service, report_service, evaluator) -> None:
        self._segmentation = segmentation_service
        self._report = report_service
        self._evaluator = evaluator

    def run(
        self,
        filenames: list[str],
        image_paths: list,
        claim_context: ClaimContext | None = None,
    ) -> AssessmentResponse:
        claim_context = claim_context or ClaimContext()

        regions = self._segmentation.analyze_images(image_paths, filenames, claim_context)
        assessment = self._build(filenames, image_paths, regions, claim_context)

        attempts: list[RetryAttempt] = []
        if ENABLE_ASSESSMENT_RETRY:
            for _ in range(MAX_ASSESSMENT_RETRIES):
                target = self._next_retryable(assessment, attempts)
                if target is None:
                    break
                attempt, regions, assessment = self._retry(
                    target, filenames, image_paths, regions, assessment, claim_context
                )
                attempts.append(attempt)

        assessment.retry_attempts = attempts
        assessment.evaluation = self._evaluator.evaluate(assessment)
        return assessment

    # ── internals ────────────────────────────────────────────────
    def _build(self, filenames, image_paths, regions, claim_context) -> AssessmentResponse:
        provider = (
            regions[0].source if regions else self._segmentation.provider_name
        )
        return self._report.build_assessment(
            filenames, image_paths, regions, provider, claim_context
        )

    def _next_retryable(self, assessment, attempts) -> str | None:
        tried = {attempt.trigger_flag for attempt in attempts}
        present = {flag.code for flag in assessment.assessment_flags}
        for code in _FLAG_PRIORITY:
            if code in present and code not in tried and code in RETRYABLE_FLAGS:
                return code
        return None

    def _narrator(self):
        return getattr(self._segmentation, "narrator", None)

    def _retry(self, code, filenames, image_paths, regions, assessment, claim_context):
        stage, hint = RETRYABLE_FLAGS[code]
        narrator = self._narrator()

        if narrator is None:
            return (
                RetryAttempt(
                    stage=stage,
                    trigger_flag=code,
                    resolved=False,
                    detail="Skipped: no model provider available to retry with.",
                ),
                regions,
                assessment,
            )

        # Snapshot so an unhelpful retry can be rolled back; the valuation stage
        # mutates region objects in place.
        previous_regions = copy.deepcopy(regions)
        previous_assessment = assessment

        try:
            if stage == "valuation":
                narrator.reground_vehicle_value(image_paths, regions, claim_context)
                new_regions = regions
            else:
                new_regions = narrator.detect_regions(
                    image_paths, filenames, claim_context, corrective_hint=hint
                )
                if not new_regions:
                    raise ValueError("retry returned no regions")
        except Exception as exc:
            logger.warning("Retry of %s stage failed: %s", stage, exc)
            return (
                RetryAttempt(
                    stage=stage,
                    trigger_flag=code,
                    resolved=False,
                    detail=f"Retry could not be completed: {exc}",
                ),
                previous_regions,
                previous_assessment,
            )

        candidate = self._build(filenames, image_paths, new_regions, claim_context)
        resolved = code not in {flag.code for flag in candidate.assessment_flags}

        if resolved:
            return (
                RetryAttempt(
                    stage=stage,
                    trigger_flag=code,
                    resolved=True,
                    detail=f"Re-ran the {stage} stage and cleared '{code}'.",
                ),
                new_regions,
                candidate,
            )

        # No improvement: keep the first result so the retry cannot regress it.
        return (
            RetryAttempt(
                stage=stage,
                trigger_flag=code,
                resolved=False,
                detail=(
                    f"Re-ran the {stage} stage but '{code}' still applies; "
                    "kept the original assessment."
                ),
            ),
            previous_regions,
            previous_assessment,
        )
