from pydantic import BaseModel


class BoundingBox(BaseModel):
    x: int
    y: int
    width: int
    height: int


class DamageRegion(BaseModel):
    panel: str
    damage_type: str
    severity: str
    confidence: float
    bounding_box: BoundingBox
    estimated_repair_cost_usd: int
    source: str


class AssessmentMeta(BaseModel):
    segmentation_provider: str
    report_provider: str
    fallback_used: bool


class AssessmentResponse(BaseModel):
    filename: str
    vehicle_type: str
    overall_severity: str
    repairability: str
    estimated_total_cost_usd: int
    recommended_action: str
    summary: str
    regions: list[DamageRegion]
    meta: AssessmentMeta
