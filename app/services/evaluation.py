"""Assessment quality evaluation.

Two graders live here:

* an LLM-as-judge that scores a finished assessment against a fixed rubric, and
* a deterministic fallback derived from the rules-based assessment flags.

The fallback matters: the adjuster queue ranks on this score, so a missing
GEMINI_API_KEY (or a failed judge call) must still yield a usable number rather
than dropping every claim to zero and flattening the queue.
"""

from __future__ import annotations

import logging

from app.core.config import ENABLE_ASSESSMENT_EVALUATOR
from app.models.schemas import AssessmentResponse, EvaluationResult, RubricScore

logger = logging.getLogger("claimsight.evaluation")

VERDICTS = ("accept", "needs_review", "reject")

# Penalties applied by the deterministic fallback.
_FLAG_PENALTY = {"high": 25, "warning": 12, "info": 3}
_COMPLETENESS_PENALTY = {"missing": 8, "partial": 4, "complete": 0}


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


def _verdict_for(score: int) -> str:
    if score >= 80:
        return "accept"
    if score >= 50:
        return "needs_review"
    return "reject"


class AssessmentEvaluator:
    def __init__(self, narrator=None) -> None:
        self._narrator = narrator

    def evaluate(self, assessment: AssessmentResponse) -> EvaluationResult:
        if ENABLE_ASSESSMENT_EVALUATOR and self._narrator is not None:
            raw = self._narrator.evaluate_assessment(self._payload(assessment))
            parsed = self._parse(raw)
            if parsed is not None:
                return parsed

        return self._fallback(assessment)

    # ── LLM judge ────────────────────────────────────────────────
    def _payload(self, assessment: AssessmentResponse) -> dict:
        """Compact projection of the assessment, so the judge sees the claims
        and the evidence without the base64 mask payloads."""
        return {
            "vehicle_type": assessment.vehicle_type,
            "overall_severity": assessment.overall_severity,
            "repairability": assessment.repairability,
            "estimated_total_cost_usd": assessment.estimated_total_cost_usd,
            "estimated_vehicle_value_usd": assessment.estimated_vehicle_value_usd,
            "total_loss": assessment.total_loss,
            "total_loss_reason": assessment.total_loss_reason,
            "recommended_action": assessment.recommended_action,
            "summary": assessment.summary,
            "valuation_methodology": assessment.valuation_methodology,
            "valuation_comparable_prices_usd": assessment.valuation_comparable_prices_usd,
            "source_count": len(assessment.sources),
            "image_count": assessment.meta.image_count,
            "pricing_factors": assessment.pricing_factors,
            "regions": [
                {
                    "panel": region.panel,
                    "damage_type": region.damage_type,
                    "severity": region.severity,
                    "confidence": region.confidence,
                    "estimated_repair_cost_usd": region.estimated_repair_cost_usd,
                }
                for region in assessment.regions
            ],
            "assessment_flags": [
                {"code": flag.code, "level": flag.level, "detail": flag.detail}
                for flag in assessment.assessment_flags
            ],
            "completeness_checks": [
                {"code": check.code, "status": check.status}
                for check in assessment.completeness_checks
            ],
        }

    def _parse(self, raw) -> EvaluationResult | None:
        if not isinstance(raw, dict):
            return None
        try:
            verdict = str(raw.get("verdict", "")).strip().lower()
            if verdict not in VERDICTS:
                verdict = ""

            rubric: list[RubricScore] = []
            for item in raw.get("rubric") or []:
                if not isinstance(item, dict):
                    continue
                rubric.append(
                    RubricScore(
                        dimension=str(item.get("dimension", ""))[:80],
                        score=_clamp(int(item.get("score") or 0), 0, 5),
                        rationale=str(item.get("rationale", ""))[:400],
                    )
                )

            score = _clamp(int(raw.get("overall_score") or 0), 0, 100)
            # A model that returns a score but an unusable verdict still gives us
            # a rankable number; derive the verdict rather than discarding it.
            return EvaluationResult(
                overall_score=score,
                verdict=verdict or _verdict_for(score),
                rubric=rubric,
                concerns=[str(c)[:300] for c in (raw.get("concerns") or [])][:8],
                evaluator_model=getattr(self._narrator, "provider_name", "") or "",
                fallback_used=False,
            )
        except (TypeError, ValueError) as exc:
            logger.warning("Could not parse evaluator response: %s", exc)
            return None

    # ── deterministic fallback ───────────────────────────────────
    def _fallback(self, assessment: AssessmentResponse) -> EvaluationResult:
        score = 100
        concerns: list[str] = []

        for flag in assessment.assessment_flags:
            score -= _FLAG_PENALTY.get(flag.level, 5)
            if flag.level in ("high", "warning"):
                concerns.append(flag.title)

        for check in assessment.completeness_checks:
            score -= _COMPLETENESS_PENALTY.get(check.status, 0)
            if check.status == "missing":
                concerns.append(check.title)

        if not assessment.regions:
            score -= 10
            concerns.append("No damage regions were detected")

        score = _clamp(score, 0, 100)
        grounded = bool(assessment.sources) and assessment.estimated_vehicle_value_usd > 0

        rubric = [
            RubricScore(
                dimension="evidence_grounding",
                score=5 if assessment.regions else 1,
                rationale="Scored from detected regions (no model judge available).",
            ),
            RubricScore(
                dimension="valuation_support",
                score=5 if grounded else 2,
                rationale="Scored from comparable sources and vehicle value.",
            ),
            RubricScore(
                dimension="completeness",
                score=_clamp(
                    5 - sum(1 for c in assessment.completeness_checks if c.status != "complete"),
                    0,
                    5,
                ),
                rationale="Scored from the completeness checks.",
            ),
        ]

        return EvaluationResult(
            overall_score=score,
            verdict=_verdict_for(score),
            rubric=rubric,
            concerns=concerns[:8],
            evaluator_model="rules",
            fallback_used=True,
        )
