from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class BoundingBox(BaseModel):
    x: int
    y: int
    width: int
    height: int


class Source(BaseModel):
    title: str = ""
    url: str = ""


class AssessmentFlag(BaseModel):
    code: str
    level: str
    title: str
    detail: str


class CompletenessCheck(BaseModel):
    code: str
    status: str
    title: str
    detail: str


class RubricScore(BaseModel):
    """One scored dimension from the assessment evaluator."""

    dimension: str
    score: int = 0  # 0-5
    rationale: str = ""


class EvaluationResult(BaseModel):
    """Quality grade for a completed assessment.

    Produced by an LLM judge when Gemini is configured, and by a deterministic
    fallback derived from the rules-based flags when it is not, so the adjuster
    queue always has a score to rank on.
    """

    overall_score: int = 0  # 0-100
    verdict: str = "needs_review"  # accept | needs_review | reject
    rubric: list[RubricScore] = Field(default_factory=list)
    concerns: list[str] = Field(default_factory=list)
    evaluator_model: str = ""
    fallback_used: bool = False


class RetryAttempt(BaseModel):
    """Record of one self-correction pass, so retries stay auditable."""

    stage: str
    trigger_flag: str
    resolved: bool = False
    detail: str = ""


class SecondPassRequest(BaseModel):
    claim_reference: str = Field(default="", max_length=120)
    vehicle: str = Field(default="", max_length=200)
    adjuster_challenge: str = Field(default="", max_length=2000)
    ai_estimate_usd: int = 0
    reviewed_estimate_usd: int = 0
    ai_recommended_action: str = Field(default="", max_length=200)
    proposed_final_action: str = Field(default="", max_length=200)
    ai_reasoning: str = Field(default="", max_length=4000)


class SecondPassResponse(BaseModel):
    reasoning: str
    agrees_with_adjuster: bool = False
    recommended_action: str = ""
    model: str = ""
    fallback_used: bool = False


class ReviewPayload(BaseModel):
    claim_reference: str = ""
    reviewer_name: str = ""
    final_action: str = ""
    notes: str = ""
    reviewed_total_cost_usd: int = 0
    ai_recommended_action: str = ""
    completed_at: str = ""


class ClaimContext(BaseModel):
    make: str = ""
    model: str = ""
    trim: str = ""
    year: Optional[int] = None
    mileage: Optional[int] = None
    pre_existing_damage: str = ""


class DamageRegion(BaseModel):
    part_id: str = ""
    panel: str
    damage_type: str
    severity: str
    confidence: float
    bounding_box: BoundingBox
    estimated_repair_cost_usd: int
    source: str
    image_index: int = 0
    ai_assessor_model: str = ""
    mask_png: str = ""  # base64 PNG of the segmentation mask, cropped to the box
    # Vehicle-level context (same across a vehicle's regions; 0/""/False when unknown).
    vehicle_value_usd: int = 0
    vehicle_label: str = ""
    # Model year as read from the image; 0 when the model cannot tell.
    # Cross-checked against the claimant's entered year to catch mismatches.
    vehicle_year_detected: int = 0
    vehicle_total_loss: bool = False
    total_loss_reason: str = ""
    valuation_methodology: str = ""
    valuation_comparable_prices_usd: list[int] = Field(default_factory=list)
    vehicle_sources: list[Source] = Field(default_factory=list)
    vehicle_search_queries: list[str] = Field(default_factory=list)
    grounding_status: str = ""


class ReviewedRegion(DamageRegion):
    review_note: str = ""


class AssessmentMeta(BaseModel):
    segmentation_provider: str
    report_provider: str
    fallback_used: bool
    image_count: int = 1
    grounding_status: str = ""
    generated_at: str = ""


class AssessmentResponse(BaseModel):
    filename: str
    filenames: list[str] = Field(default_factory=list)
    vehicle_type: str
    estimated_vehicle_value_usd: int = 0
    valuation_methodology: str = ""
    valuation_comparable_prices_usd: list[int] = Field(default_factory=list)
    total_loss: bool = False
    total_loss_reason: str = ""
    overall_severity: str
    repairability: str
    estimated_total_cost_usd: int
    recommended_action: str
    summary: str
    regions: list[DamageRegion]
    sources: list[Source] = Field(default_factory=list)
    search_queries: list[str] = Field(default_factory=list)
    claim_context: ClaimContext = Field(default_factory=ClaimContext)
    pricing_factors: list[str] = Field(default_factory=list)
    assessment_flags: list[AssessmentFlag] = Field(default_factory=list)
    completeness_checks: list[CompletenessCheck] = Field(default_factory=list)
    evaluation: Optional[EvaluationResult] = None
    retry_attempts: list[RetryAttempt] = Field(default_factory=list)
    meta: AssessmentMeta


class CaseSavePayload(AssessmentResponse):
    reviewed_regions: list[ReviewedRegion] = Field(default_factory=list)
    review: ReviewPayload = Field(default_factory=ReviewPayload)


class ClaimAssistantMessage(BaseModel):
    role: str = Field(default="user", pattern="^(user|assistant)$")
    text: str = Field(default="", max_length=2000)


class ClaimAssistantContext(BaseModel):
    claim_reference: str = ""
    page_title: str = ""
    status: str = ""
    vehicle: str = ""
    adjuster: str = ""
    ai_view: str = ""
    final_action: str = ""
    note: str = ""


class ClaimAssistantRequest(BaseModel):
    message: str = Field(min_length=1, max_length=1200)
    context: ClaimAssistantContext = Field(default_factory=ClaimAssistantContext)
    history: list[ClaimAssistantMessage] = Field(default_factory=list, max_length=12)


class ClaimAssistantResponse(BaseModel):
    answer: str
    model: str
    fallback_used: bool = False
