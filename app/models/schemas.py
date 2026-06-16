from pydantic import BaseModel, Field


class BoundingBox(BaseModel):
    x: int
    y: int
    width: int
    height: int


class Source(BaseModel):
    title: str = ""
    url: str = ""


class ClaimContext(BaseModel):
    make: str = ""
    model: str = ""
    trim: str = ""
    year: int | None = None
    mileage: int | None = None
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
    vehicle_total_loss: bool = False
    total_loss_reason: str = ""
    valuation_methodology: str = ""
    valuation_comparable_prices_usd: list[int] = Field(default_factory=list)
    vehicle_sources: list[Source] = Field(default_factory=list)
    vehicle_search_queries: list[str] = Field(default_factory=list)
    grounding_status: str = ""


class AssessmentMeta(BaseModel):
    segmentation_provider: str
    report_provider: str
    fallback_used: bool
    image_count: int = 1
    grounding_status: str = ""


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
    meta: AssessmentMeta
