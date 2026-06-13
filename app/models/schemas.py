from pydantic import BaseModel


class BoundingBox(BaseModel):
    x: int
    y: int
    width: int
    height: int


class Source(BaseModel):
    title: str = ""
    url: str = ""


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
    # Vehicle-level context (same across a vehicle's regions; 0/""/False when unknown).
    vehicle_value_usd: int = 0
    vehicle_label: str = ""
    vehicle_total_loss: bool = False
    total_loss_reason: str = ""
    vehicle_sources: list[Source] = []
    vehicle_search_queries: list[str] = []


class AssessmentMeta(BaseModel):
    segmentation_provider: str
    report_provider: str
    fallback_used: bool
    image_count: int = 1


class AssessmentResponse(BaseModel):
    filename: str
    filenames: list[str] = []
    vehicle_type: str
    estimated_vehicle_value_usd: int = 0
    total_loss: bool = False
    total_loss_reason: str = ""
    overall_severity: str
    repairability: str
    estimated_total_cost_usd: int
    recommended_action: str
    summary: str
    regions: list[DamageRegion]
    sources: list[Source] = []
    search_queries: list[str] = []
    meta: AssessmentMeta
