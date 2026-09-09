"""Tests for the assessment evaluator and the self-correction loop."""

from pathlib import Path

from fastapi.testclient import TestClient

from app.api import routes
from app.main import app
from app.models.schemas import (
    AssessmentFlag,
    AssessmentMeta,
    AssessmentResponse,
    BoundingBox,
    ClaimContext,
    CompletenessCheck,
    DamageRegion,
)
from app.services.assessment_pipeline import AssessmentPipeline
from app.services.case_repository import CaseRepository
from app.services.evaluation import AssessmentEvaluator

client = TestClient(app)


def _region(confidence: float = 0.9, value: int = 14000) -> DamageRegion:
    return DamageRegion(
        panel="front bumper",
        damage_type="dent",
        severity="moderate",
        confidence=confidence,
        bounding_box=BoundingBox(x=0, y=0, width=10, height=10),
        estimated_repair_cost_usd=1200,
        source="test",
        vehicle_value_usd=value,
    )


def _assessment(flags=None, checks=None, regions=None) -> AssessmentResponse:
    return AssessmentResponse(
        filename="a.jpg",
        vehicle_type="2023 Toyota Camry",
        overall_severity="moderate",
        repairability="repair",
        estimated_total_cost_usd=1200,
        recommended_action="Repair",
        summary="Summary.",
        regions=regions if regions is not None else [_region()],
        assessment_flags=flags or [],
        completeness_checks=checks or [],
        meta=AssessmentMeta(
            segmentation_provider="test", report_provider="test", fallback_used=False
        ),
    )


# ── evaluator ────────────────────────────────────────────────────
def test_fallback_scores_from_flags_when_no_model() -> None:
    result = AssessmentEvaluator(narrator=None).evaluate(
        _assessment(
            flags=[
                AssessmentFlag(code="a", level="high", title="High", detail="d"),
                AssessmentFlag(code="b", level="warning", title="Warn", detail="d"),
            ],
            checks=[CompletenessCheck(code="c", status="missing", title="Photos", detail="d")],
        )
    )
    assert result.fallback_used is True
    assert result.evaluator_model == "rules"
    assert result.overall_score == 100 - 25 - 12 - 8
    assert result.verdict == "needs_review"
    assert "High" in result.concerns


def test_clean_assessment_scores_accept() -> None:
    result = AssessmentEvaluator(narrator=None).evaluate(_assessment())
    assert result.overall_score == 100
    assert result.verdict == "accept"


class _Judge:
    provider_name = "judge-model"

    def __init__(self, payload):
        self.payload = payload
        self.seen = None

    def evaluate_assessment(self, payload):
        self.seen = payload
        return self.payload


def test_uses_llm_judge_when_available() -> None:
    judge = _Judge(
        {
            "overall_score": 88,
            "verdict": "accept",
            "rubric": [{"dimension": "evidence_grounding", "score": 4, "rationale": "ok"}],
            "concerns": ["minor"],
        }
    )
    result = AssessmentEvaluator(narrator=judge).evaluate(_assessment())
    assert result.fallback_used is False
    assert result.overall_score == 88
    assert result.verdict == "accept"
    assert result.rubric[0].dimension == "evidence_grounding"
    # the judge must not receive base64 mask blobs
    assert "mask_png" not in str(judge.seen)


def test_judge_scores_are_clamped_and_verdict_repaired() -> None:
    judge = _Judge({"overall_score": 900, "verdict": "banana", "rubric": [
        {"dimension": "x", "score": 99, "rationale": "r"}
    ]})
    result = AssessmentEvaluator(narrator=judge).evaluate(_assessment())
    assert result.overall_score == 100
    assert result.rubric[0].score == 5
    assert result.verdict == "accept"  # derived from the score


def test_falls_back_when_judge_returns_garbage() -> None:
    result = AssessmentEvaluator(narrator=_Judge("not-a-dict")).evaluate(_assessment())
    assert result.fallback_used is True


# ── retry loop ───────────────────────────────────────────────────
class _Segmentation:
    provider_name = "fake"

    def __init__(self, narrator=None):
        self.narrator = narrator
        self.calls = 0

    def analyze_images(self, paths, filenames, claim_context=None):
        self.calls += 1
        return [_region()]


class _Report:
    """Emits the ungrounded-value flag until told to stop."""

    def __init__(self, resolve_after=None):
        self.resolve_after = resolve_after
        self.builds = 0

    def build_assessment(self, filenames, paths, regions, provider, claim_context):
        self.builds += 1
        flagged = self.resolve_after is None or self.builds <= self.resolve_after
        flags = (
            [AssessmentFlag(code="value_not_grounded", level="warning", title="V", detail="d")]
            if flagged
            else []
        )
        return _assessment(flags=flags, regions=regions)


class _Narrator:
    provider_name = "m"

    def __init__(self):
        self.reground_calls = 0
        self.detect_calls = 0

    def reground_vehicle_value(self, paths, regions, claim_context=None):
        self.reground_calls += 1
        return True

    def detect_regions(self, paths, filenames, claim_context=None, corrective_hint=""):
        self.detect_calls += 1
        return [_region()]

    def evaluate_assessment(self, payload):
        return None


def _run(report, narrator):
    pipeline = AssessmentPipeline(
        _Segmentation(narrator), report, AssessmentEvaluator(narrator=None)
    )
    return pipeline.run(["a.jpg"], [Path("a.jpg")], ClaimContext())


def test_retry_targets_only_the_valuation_stage() -> None:
    narrator = _Narrator()
    result = _run(_Report(resolve_after=1), narrator)
    assert narrator.reground_calls == 1
    assert narrator.detect_calls == 0, "grounding flag must not trigger a full re-detection"
    assert result.retry_attempts[0].resolved is True
    assert result.assessment_flags == []


def test_unhelpful_retry_is_rolled_back() -> None:
    narrator = _Narrator()
    result = _run(_Report(resolve_after=None), narrator)
    attempt = result.retry_attempts[0]
    assert attempt.resolved is False
    assert "kept the original" in attempt.detail
    # the flag survives, so the adjuster still sees the real weakness
    assert [f.code for f in result.assessment_flags] == ["value_not_grounded"]


def test_retries_are_capped() -> None:
    from app.core import config

    narrator = _Narrator()
    result = _run(_Report(resolve_after=None), narrator)
    assert len(result.retry_attempts) <= config.MAX_ASSESSMENT_RETRIES
    assert narrator.reground_calls <= config.MAX_ASSESSMENT_RETRIES


def test_non_retryable_flag_costs_nothing() -> None:
    class OnlyPhotoFlag(_Report):
        def build_assessment(self, filenames, paths, regions, provider, claim_context):
            return _assessment(
                flags=[
                    AssessmentFlag(
                        code="limited_photo_set", level="warning", title="P", detail="d"
                    )
                ],
                regions=regions,
            )

    narrator = _Narrator()
    result = _run(OnlyPhotoFlag(), narrator)
    assert result.retry_attempts == []
    assert narrator.reground_calls == 0
    assert narrator.detect_calls == 0


def test_retry_is_skipped_without_a_provider() -> None:
    result = _run(_Report(resolve_after=None), None)
    assert result.retry_attempts[0].resolved is False
    assert "no model provider" in result.retry_attempts[0].detail


# ── queue ranking ────────────────────────────────────────────────
def test_evaluator_verdict_raises_queue_priority() -> None:
    repo = CaseRepository.__new__(CaseRepository)
    base = {
        "assessment_flags": [],
        "completeness_checks": [],
        "review": {},
        "repairability": "repair",
        "overall_severity": "low",
    }
    _, clean = repo._triage(dict(base))
    _, rejected = repo._triage({**base, "evaluation": {"verdict": "reject", "overall_score": 30}})
    assert rejected > clean


# ── second pass endpoint ─────────────────────────────────────────
def _second_pass_body() -> dict:
    return {
        "claim_reference": "CLM-1",
        "vehicle": "2023 Toyota Camry",
        "adjuster_challenge": "Rear bumper needs replacement, not repair.",
        "ai_estimate_usd": 1200,
        "reviewed_estimate_usd": 2400,
    }


def test_second_pass_requires_authentication() -> None:
    original = routes.supabase_auth.verify_bearer_token
    routes.supabase_auth.verify_bearer_token = lambda authorization: None
    try:
        assert client.post("/api/second-pass", json=_second_pass_body()).status_code == 401
    finally:
        routes.supabase_auth.verify_bearer_token = original


def test_second_pass_rejects_customer_role() -> None:
    original = routes.supabase_auth.verify_bearer_token
    routes.supabase_auth.verify_bearer_token = lambda authorization: {
        "uid": "c1", "role": "customer"
    }
    try:
        assert client.post("/api/second-pass", json=_second_pass_body()).status_code == 403
    finally:
        routes.supabase_auth.verify_bearer_token = original


def test_second_pass_returns_model_result_for_employee() -> None:
    original = routes.supabase_auth.verify_bearer_token
    original_review = routes.claim_assistant.second_pass_review
    routes.supabase_auth.verify_bearer_token = lambda authorization: {
        "uid": "e1", "role": "employee"
    }
    routes.claim_assistant.second_pass_review = lambda payload: {
        "reasoning": "The adjuster is right that the bumper is not repairable.",
        "agrees_with_adjuster": True,
        "recommended_action": "Approve revised estimate",
    }
    try:
        response = client.post("/api/second-pass", json=_second_pass_body())
        assert response.status_code == 200
        body = response.json()
        assert body["agrees_with_adjuster"] is True
        assert body["fallback_used"] is False
        assert "not repairable" in body["reasoning"]
    finally:
        routes.supabase_auth.verify_bearer_token = original
        routes.claim_assistant.second_pass_review = original_review


def test_second_pass_fallback_is_labelled_as_not_ai() -> None:
    original = routes.supabase_auth.verify_bearer_token
    original_review = routes.claim_assistant.second_pass_review
    routes.supabase_auth.verify_bearer_token = lambda authorization: {
        "uid": "e1", "role": "employee"
    }
    routes.claim_assistant.second_pass_review = lambda payload: None
    try:
        body = client.post("/api/second-pass", json=_second_pass_body()).json()
        assert body["fallback_used"] is True
        assert body["model"] == "rules"
        # must not imply a model reviewed the challenge
        assert "not an AI second pass" in body["reasoning"]
        assert "$2,400" in body["reasoning"]
    finally:
        routes.supabase_auth.verify_bearer_token = original
        routes.claim_assistant.second_pass_review = original_review


# ── confidence-independent consistency flags ─────────────────────
# The model reported 0.95-0.99 confidence on an assessment that omitted all
# structural work and accepted a wrong model year, so these checks look at
# the numbers rather than asking the model how sure it is.
from app.services.report_generation import ClaimReportService  # noqa: E402


def _build(regions, ctx=None, value=None):
    svc = ClaimReportService()
    out = svc.build_assessment(
        ["a.jpg"], [Path("a.jpg")], regions, "test", ctx or ClaimContext()
    )
    return {f.code for f in out.assessment_flags}, out


def _r(panel="hood", severity="high", cost=500, conf=0.97, value=10000, year=0):
    return DamageRegion(
        panel=panel, damage_type="crumpled", severity=severity, confidence=conf,
        bounding_box=BoundingBox(x=0, y=0, width=10, height=10),
        estimated_repair_cost_usd=cost, source="test",
        vehicle_value_usd=value, vehicle_year_detected=year,
    )


def test_flags_thin_total_loss_margin() -> None:
    """Repair lands within a few percent of value, so the verdict is a coin flip.

    Spread across three panels on purpose: a single panel carrying the whole
    2700 would exceed PANEL_COST_CAP_RATIO of the vehicle value and be capped
    first, which is a different (and correctly reported) finding.
    """
    regions = [
        _r(panel="front bumper", cost=900, value=2746),
        _r(panel="hood", cost=900, value=2746),
        _r(panel="front fender", cost=900, value=2746),
    ]
    codes, out = _build(regions, ClaimContext())
    assert "panel_cost_capped" not in codes, "no single panel should trip the cap here"
    assert out.estimated_total_cost_usd == 2700
    assert "total_loss_margin_thin" in codes


def test_does_not_flag_a_clear_margin() -> None:
    codes, _ = _build([_r(cost=6100, value=3089)], ClaimContext())
    assert "total_loss_margin_thin" not in codes


def test_flags_high_severity_with_no_structural_line_item() -> None:
    regions = [
        _r(panel="front bumper"), _r(panel="hood"), _r(panel="windshield"),
    ]
    codes, _ = _build(regions)
    assert "possible_underscoped_structural" in codes


def test_structural_line_item_clears_the_flag() -> None:
    regions = [
        _r(panel="front bumper"), _r(panel="hood"),
        _r(panel="front grille and radiator support"),
    ]
    codes, _ = _build(regions)
    assert "possible_underscoped_structural" not in codes


def test_flags_year_conflict_between_claim_and_photo() -> None:
    codes, _ = _build([_r(year=2001)], ClaimContext(year=2003, make="Renault"))
    assert "vehicle_identity_conflict" in codes


def test_one_year_apart_is_tolerated() -> None:
    codes, _ = _build([_r(year=2002)], ClaimContext(year=2003))
    assert "vehicle_identity_conflict" not in codes


def test_no_conflict_when_model_cannot_read_the_year() -> None:
    codes, _ = _build([_r(year=0)], ClaimContext(year=2003))
    assert "vehicle_identity_conflict" not in codes


# ── the judge as a retry trigger ─────────────────────────────────
class _ScriptedJudge:
    """Judge returning a scripted sequence of grades."""

    provider_name = "judge"

    def __init__(self, grades):
        self.grades = list(grades)
        self.calls = 0

    def evaluate_assessment(self, payload):
        self.calls += 1
        g = self.grades[min(self.calls - 1, len(self.grades) - 1)]
        return {
            "overall_score": g["score"],
            "verdict": g.get("verdict", "needs_review"),
            "rubric": [
                {"dimension": d, "score": sc, "rationale": "r"}
                for d, sc in g.get("rubric", {}).items()
            ],
            "concerns": [],
        }


class _CleanReport:
    """Emits no flags, so only the judge can trigger anything."""

    def build_assessment(self, filenames, paths, regions, provider, claim_context):
        return _assessment(regions=regions)


def test_judge_weak_dimension_triggers_a_retry() -> None:
    judge = _ScriptedJudge([
        {"score": 40, "rubric": {"valuation_support": 1}},   # initial: weak
        {"score": 90, "rubric": {"valuation_support": 5}},   # after retry: better
    ])
    narrator = _Narrator()
    pipeline = AssessmentPipeline(
        _Segmentation(narrator), _CleanReport(), AssessmentEvaluator(narrator=judge)
    )
    out = pipeline.run(["a.jpg"], [Path("a.jpg")], ClaimContext())

    assert len(out.retry_attempts) == 1
    a = out.retry_attempts[0]
    assert a.trigger_flag == "judge:valuation_support"
    assert a.stage == "valuation"
    assert narrator.reground_calls == 1
    assert out.evaluation.overall_score == 90, "improved grade must be kept"


def test_judge_triggered_retry_is_rolled_back_when_grade_drops() -> None:
    judge = _ScriptedJudge([
        {"score": 60, "rubric": {"valuation_support": 2}},
        {"score": 30, "rubric": {"valuation_support": 1}},  # retry made it worse
    ])
    pipeline = AssessmentPipeline(
        _Segmentation(_Narrator()), _CleanReport(), AssessmentEvaluator(narrator=judge)
    )
    out = pipeline.run(["a.jpg"], [Path("a.jpg")], ClaimContext())

    assert out.retry_attempts[0].resolved is False
    assert "did not improve" in out.retry_attempts[0].detail
    assert out.evaluation.overall_score == 60, "must keep the better original grade"


def test_strong_judge_grade_triggers_nothing() -> None:
    judge = _ScriptedJudge([{"score": 95, "verdict": "accept",
                             "rubric": {"valuation_support": 5, "evidence_grounding": 5}}])
    narrator = _Narrator()
    pipeline = AssessmentPipeline(
        _Segmentation(narrator), _CleanReport(), AssessmentEvaluator(narrator=judge)
    )
    out = pipeline.run(["a.jpg"], [Path("a.jpg")], ClaimContext())
    assert out.retry_attempts == []
    assert narrator.reground_calls == 0 and narrator.detect_calls == 0


def test_fallback_grade_is_not_used_as_a_trigger() -> None:
    """The deterministic fallback derives its rubric from the same flags the
    loop already handles, so trusting it as an independent signal would
    double-count and retry on every ungrounded assessment."""
    narrator = _Narrator()
    pipeline = AssessmentPipeline(
        _Segmentation(narrator), _CleanReport(), AssessmentEvaluator(narrator=None)
    )
    out = pipeline.run(["a.jpg"], [Path("a.jpg")], ClaimContext())
    assert out.evaluation.fallback_used is True

    # The fallback genuinely emits a weak dimension here (no cited sources),
    # which is exactly the signal that must NOT be acted on.
    weak = [r for r in out.evaluation.rubric if r.score <= 2]
    assert weak, "fallback should have produced a weak dimension to ignore"
    assert any(r.dimension == "valuation_support" for r in weak)

    assert out.retry_attempts == [], "fallback rubric must not drive a retry"
    assert narrator.reground_calls == 0 and narrator.detect_calls == 0
