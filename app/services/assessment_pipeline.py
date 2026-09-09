"""Assessment orchestration: detect -> grade -> self-correct -> re-grade.

The evaluator runs BEFORE the retry loop so its verdict can drive a
correction, rather than arriving afterwards as a report card. A retry is
kept only when the grade holds up, so a second model call cannot quietly
make the assessment worse.

Two independent things can trigger a retry:

* deterministic flags from the rules layer, and
* a weak rubric dimension from the LLM judge.

The judge is only trusted as a trigger when it actually ran. Its
deterministic fallback derives its rubric from the same flags handled
above, so treating that as an independent signal would double-count.

Cost: one judge call up front, plus one stage call and one re-grade per
retry. With MAX_ASSESSMENT_RETRIES=1 the worst case is four model calls.
"""

from __future__ import annotations

import copy
import logging

from app.core.config import (
    ENABLE_ASSESSMENT_RETRY,
    MAX_ASSESSMENT_RETRIES,
    RETRY_DETECTION_MODEL,
)
from app.models.schemas import AssessmentResponse, ClaimContext, RetryAttempt

logger = logging.getLogger("claimsight.pipeline")

# Flags worth spending another model call on. Anything absent here is not
# retryable: limited_photo_set cannot invent a photo the claimant never sent,
# and repair_ratio_exceeds_threshold is a finding, not a fault.
RETRYABLE_FLAGS: dict[str, tuple[str, str]] = {
    "value_not_grounded": (
        "valuation",
        "No defensible vehicle value was produced. Search for real comparable "
        "listings for this specific vehicle and base the value on them.",
    ),
    "weak_market_grounding": (
        "valuation",
        "The vehicle value was not backed by comparable market listings. Find "
        "real comparable listings and cite them.",
    ),
    "total_loss_margin_thin": (
        "valuation",
        "Estimated repairs and vehicle value came out nearly equal, so the "
        "repair-versus-total-loss decision rests on both being precise. "
        "Re-derive the vehicle value from actual comparable listings.",
    ),
    "possible_underscoped_structural": (
        "detection",
        "Several panels were rated high severity but no structural component "
        "was priced. Look specifically for deformed frame rails, radiator "
        "support, A-pillar or door-aperture misalignment, and price them if "
        "the image supports it.",
    ),
    "vehicle_identity_conflict": (
        "detection",
        "The reported model year disagrees with the vehicle in the image. "
        "Re-read the styling and badging and report the year you actually see.",
    ),
    "low_visual_confidence": (
        "detection",
        "Damage regions were detected with low confidence. Look again more "
        "carefully, and only report parts you can actually see damage on.",
    ),
}

# Highest-value first: a bad valuation distorts the total-loss call, which is
# the decision the adjuster acts on.
_FLAG_PRIORITY = (
    "total_loss_margin_thin",
    "value_not_grounded",
    "weak_market_grounding",
    "possible_underscoped_structural",
    "vehicle_identity_conflict",
    "low_visual_confidence",
)

# A judge rubric dimension at or below this score is treated as a defect.
WEAK_DIMENSION_SCORE = 2

# Which stage can plausibly fix a weak dimension. "completeness" is absent
# because the fix is more photos, which no retry can produce.
RUBRIC_STAGES: dict[str, tuple[str, str]] = {
    "valuation_support": (
        "valuation",
        "A quality audit judged the vehicle valuation poorly supported. "
        "Ground the value in real comparable listings and cite them.",
    ),
    "evidence_grounding": (
        "detection",
        "A quality audit judged the damage findings poorly grounded in the "
        "image. Re-examine the photos and only report visible damage.",
    ),
    "severity_justification": (
        "detection",
        "A quality audit judged the severity ratings unsupported by the "
        "evidence. Re-examine each panel and justify its severity.",
    ),
    "internal_consistency": (
        "detection",
        "A quality audit found the assessment internally inconsistent. "
        "Re-examine the damage so costs and severities agree with each other.",
    ),
}


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
        evaluation = self._evaluator.evaluate(assessment)

        attempts: list[RetryAttempt] = []
        if ENABLE_ASSESSMENT_RETRY:
            for _ in range(MAX_ASSESSMENT_RETRIES):
                target = self._next_target(assessment, evaluation, attempts)
                if target is None:
                    break
                attempt, regions, assessment, evaluation = self._retry(
                    target, filenames, image_paths, regions, assessment, evaluation, claim_context
                )
                attempts.append(attempt)

        assessment.retry_attempts = attempts
        assessment.evaluation = evaluation
        return assessment

    # ── internals ────────────────────────────────────────────────
    def _build(self, filenames, image_paths, regions, claim_context) -> AssessmentResponse:
        provider = regions[0].source if regions else self._segmentation.provider_name
        return self._report.build_assessment(
            filenames, image_paths, regions, provider, claim_context
        )

    def _stage_usable(self, stage: str) -> bool:
        """Whether a stage can plausibly succeed right now.

        Grounded search has its own quota. When it is exhausted, a valuation
        retry cannot win, and with MAX_ASSESSMENT_RETRIES=1 it would consume
        the only retry available -- starving the detection stage, which does
        not depend on that quota and has been observed to fix real defects.
        """
        if stage != "valuation":
            return True
        narrator = self._narrator()
        if narrator is None:
            # No provider at all is a different problem. Let the attempt run so
            # it gets recorded as skipped, rather than vanishing silently.
            return True
        return bool(getattr(narrator, "grounding_available", True))

    def _next_target(self, assessment, evaluation, attempts):
        """Pick what to retry: (trigger_label, stage, hint) or None."""
        tried = {a.trigger_flag for a in attempts}

        # 1. deterministic flags
        present = {f.code for f in assessment.assessment_flags}
        for code in _FLAG_PRIORITY:
            if code in present and code not in tried:
                stage, hint = RETRYABLE_FLAGS[code]
                if not self._stage_usable(stage):
                    continue  # let a usable stage have the retry instead
                return code, stage, hint

        # 2. the judge, but only when a real model produced the verdict
        if evaluation is None or evaluation.fallback_used:
            return None

        weak = [
            r for r in evaluation.rubric
            if r.score <= WEAK_DIMENSION_SCORE and r.dimension in RUBRIC_STAGES
        ]
        weak.sort(key=lambda r: r.score)
        for r in weak:
            label = f"judge:{r.dimension}"
            if label not in tried:
                stage, hint = RUBRIC_STAGES[r.dimension]
                if not self._stage_usable(stage):
                    continue
                return label, stage, hint

        # A reject verdict with no single weak dimension still warrants one
        # look at the detection, which is what everything else derives from.
        if evaluation.verdict == "reject" and "judge:verdict" not in tried:
            return (
                "judge:verdict",
                "detection",
                "A quality audit rejected this assessment. Re-examine the "
                "images and produce a more defensible set of findings.",
            )
        return None

    def _narrator(self):
        return getattr(self._segmentation, "narrator", None)

    def _retry(
        self, target, filenames, image_paths, regions, assessment, evaluation, claim_context
    ):
        code, stage, hint = target
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
                evaluation,
            )

        # Snapshot so an unhelpful retry can be rolled back; the valuation
        # stage mutates region objects in place.
        previous_regions = copy.deepcopy(regions)

        try:
            if stage == "valuation":
                narrator.reground_vehicle_value(image_paths, regions, claim_context)
                new_regions = regions
            else:
                # Escalate: the first pass runs on the cheap high-RPD model,
                # and a scarcer, stronger model is spent only here -- on the
                # rare occasion that pass produced something the rules flagged.
                new_regions = narrator.detect_regions(
                    image_paths,
                    filenames,
                    claim_context,
                    corrective_hint=hint,
                    model=RETRY_DETECTION_MODEL,
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
                assessment,
                evaluation,
            )

        candidate = self._build(filenames, image_paths, new_regions, claim_context)
        candidate_eval = self._evaluator.evaluate(candidate)

        flag_cleared = code not in {f.code for f in candidate.assessment_flags}
        before = evaluation.overall_score if evaluation else 0
        after = candidate_eval.overall_score if candidate_eval else 0

        # Keep the retry only if the grade holds up. A second call is not
        # automatically a better one, and a silent regression is worse than a
        # known gap.
        improved = after > before or (flag_cleared and after >= before)

        if improved:
            return (
                RetryAttempt(
                    stage=stage,
                    trigger_flag=code,
                    resolved=flag_cleared,
                    detail=(
                        f"Re-ran the {stage} stage for '{code}'; "
                        f"score {before} -> {after}"
                        + (", trigger cleared." if flag_cleared else ", trigger persists.")
                    ),
                ),
                new_regions,
                candidate,
                candidate_eval,
            )

        return (
            RetryAttempt(
                stage=stage,
                trigger_flag=code,
                resolved=False,
                detail=(
                    f"Re-ran the {stage} stage for '{code}' but the grade did not "
                    f"improve ({before} -> {after}); kept the original assessment."
                ),
            ),
            previous_regions,
            assessment,
            evaluation,
        )
