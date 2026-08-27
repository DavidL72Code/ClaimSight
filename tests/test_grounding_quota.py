"""Grounded search has its own quota, separate from generation.

Every grounding attempt used to make two calls: google_search, then
google_search_retrieval. The second shape is Gemini 1.5-only, so on a 3.x
model it could never succeed -- and because a 429 was treated as "tool not
accepted", the retry spent a second unit of the quota that had just run out.
With the self-correction loop on, that was 4 grounded calls per assessment,
half of them structurally incapable of working.
"""

import time

import pytest

from app.services import gemini_client as gc


@pytest.fixture(autouse=True)
def _reset_breaker():
    gc._grounding_blocked_until = 0.0
    yield
    gc._grounding_blocked_until = 0.0


# ── classifying the failure ──────────────────────────────────────
@pytest.mark.parametrize("message", [
    "429 RESOURCE_EXHAUSTED",
    "Error: 429 quota exceeded",
    "{'error': {'code': 429, 'status': 'RESOURCE_EXHAUSTED'}}",
])
def test_quota_errors_are_recognised(message) -> None:
    assert gc._is_quota_error(Exception(message)) is True


@pytest.mark.parametrize("message", [
    "400 INVALID_ARGUMENT: tool not supported",
    "unexpected keyword argument 'google_search_retrieval'",
    "503 UNAVAILABLE",
])
def test_non_quota_errors_are_not_mistaken_for_quota(message) -> None:
    """These are the cases the tool-shape fallback exists for."""
    assert gc._is_quota_error(Exception(message)) is False


# ── choosing the tool shape ──────────────────────────────────────
def _shape_names(shapes):
    return [next(iter(s.model_dump(exclude_none=True))) for s in shapes]


def test_modern_models_try_google_search_first(monkeypatch) -> None:
    from google.genai import types
    monkeypatch.setattr(gc, "GEMINI_MODEL", "gemini-3.5-flash-lite")
    assert _shape_names(gc._search_tools(types))[0] == "google_search"


def test_legacy_models_try_the_retrieval_shape_first(monkeypatch) -> None:
    from google.genai import types
    monkeypatch.setattr(gc, "GEMINI_MODEL", "gemini-1.5-flash")
    assert _shape_names(gc._search_tools(types))[0] == "google_search_retrieval"


# ── the circuit breaker ──────────────────────────────────────────
def test_breaker_starts_closed() -> None:
    assert gc._grounding_available() is True


def test_breaker_trips_and_blocks_further_attempts() -> None:
    gc._block_grounding()
    assert gc._grounding_available() is False


def test_breaker_expires_so_a_per_minute_429_is_not_permanent(monkeypatch) -> None:
    """Some 429s are per-minute, not daily. A permanent trip would disable
    grounding for the whole life of the process."""
    gc._block_grounding()
    assert gc._grounding_available() is False
    later = time.monotonic() + gc._GROUNDING_COOLDOWN_SECONDS + 1
    monkeypatch.setattr(gc.time, "monotonic", lambda: later)
    assert gc._grounding_available() is True


def test_narrator_exposes_breaker_state() -> None:
    n = gc.GeminiClaimNarrator()
    assert n.grounding_available is True
    gc._block_grounding()
    assert n.grounding_available is False


# ── the retry loop must not spend its one retry on a dead stage ──
def test_loop_skips_valuation_while_grounding_is_exhausted() -> None:
    from pathlib import Path
    from app.models.schemas import (
        AssessmentFlag, AssessmentMeta, AssessmentResponse, BoundingBox,
        ClaimContext, DamageRegion,
    )
    from app.services.assessment_pipeline import AssessmentPipeline
    from app.services.evaluation import AssessmentEvaluator

    region = DamageRegion(
        panel="hood", damage_type="crumpled", severity="high", confidence=0.97,
        bounding_box=BoundingBox(x=0, y=0, width=10, height=10),
        estimated_repair_cost_usd=900, source="test",
    )

    def assessment_with(codes):
        return AssessmentResponse(
            filename="a.jpg", vehicle_type="car", overall_severity="high",
            repairability="repair", estimated_total_cost_usd=900,
            recommended_action="x", summary="s", regions=[region],
            assessment_flags=[
                AssessmentFlag(code=c, level="warning", title=c, detail="d") for c in codes
            ],
            meta=AssessmentMeta(segmentation_provider="t", report_provider="t", fallback_used=False),
        )

    class Narrator:
        provider_name = "m"
        grounding_available = False          # quota exhausted
        def __init__(self): self.reground = 0; self.detect = 0
        def reground_vehicle_value(self, *a, **k): self.reground += 1; return True
        def detect_regions(self, *a, **k): self.detect += 1; return [region]
        def evaluate_assessment(self, payload): return None

    class Seg:
        provider_name = "t"
        def __init__(self, n): self.narrator = n
        def analyze_images(self, *a, **k): return [region]

    class Report:
        # both a valuation trigger and a detection trigger are present
        def build_assessment(self, *a, **k):
            return assessment_with(["weak_market_grounding", "possible_underscoped_structural"])

    narrator = Narrator()
    out = AssessmentPipeline(Seg(narrator), Report(), AssessmentEvaluator(None)).run(
        ["a.jpg"], [Path("a.jpg")], ClaimContext()
    )

    assert narrator.reground == 0, "must not call a stage that is out of quota"
    assert narrator.detect == 1, "the retry should go to the stage that can still work"
    assert out.retry_attempts[0].stage == "detection"
