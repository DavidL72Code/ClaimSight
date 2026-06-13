from hmac import compare_digest
from io import BytesIO
from pathlib import Path
import re
from time import monotonic
from uuid import uuid4

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from PIL import Image, UnidentifiedImageError

from app.core.config import (
    API_ACCESS_TOKEN,
    MAX_IMAGE_PIXELS,
    MAX_UPLOAD_BYTES,
    RATE_LIMIT_MAX_REQUESTS,
    RATE_LIMIT_WINDOW_SECONDS,
    SAM2_MODEL_ID,
    SEGMENTATION_PROVIDER,
    UPLOAD_DIR,
)
from app.models.schemas import AssessmentResponse
from app.services.report_generation import ClaimReportService
from app.services.segmentation import get_segmentation_service

router = APIRouter()

segmentation_service = get_segmentation_service()
report_service = ClaimReportService()

ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
ALLOWED_MIME_TYPES = {"image/jpeg", "image/png", "image/webp"}
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
_request_log: dict[str, list[float]] = {}
_SAFE_FILENAME_PATTERN = re.compile(r"[^A-Za-z0-9._ -]+")


def _health_payload() -> dict[str, object]:
    payload: dict[str, object] = {
        "status": "ok",
        "segmentation_provider": SEGMENTATION_PROVIDER,
        "active_segmentation_provider": segmentation_service.provider_name,
        "sam2_model_id": SAM2_MODEL_ID,
    }

    if hasattr(segmentation_service, "ready"):
        payload["segmentation_ready"] = bool(getattr(segmentation_service, "ready"))
    if hasattr(segmentation_service, "load_error"):
        payload["segmentation_load_error"] = bool(getattr(segmentation_service, "load_error"))

    return payload


@router.get("/health")
def health_check() -> dict[str, object]:
    return _health_payload()


@router.get("/api/health")
def api_health_check() -> dict[str, object]:
    return _health_payload()


@router.post("/api/assess", response_model=AssessmentResponse)
async def assess_damage(request: Request, file: UploadFile = File(...)) -> AssessmentResponse:
    _enforce_optional_api_token(request)
    _enforce_rate_limit(request)

    if not file.filename:
        raise HTTPException(status_code=400, detail="A file is required.")

    original_filename = _safe_display_filename(file.filename)
    extension = Path(original_filename).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Supported formats: .jpg, .jpeg, .png, .webp")

    if file.content_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(status_code=400, detail="Uploaded file must be a JPEG, PNG, or WebP image.")

    _validate_content_length(request)

    safe_name = f"{uuid4().hex}{extension}"
    destination = UPLOAD_DIR / safe_name
    content = await _read_limited_upload(file)
    _validate_upload_size(content)
    content = _validate_image_content(content)
    destination.write_bytes(content)

    regions = segmentation_service.analyze(destination, original_filename)
    segmentation_provider = regions[0].source if regions else segmentation_service.provider_name
    return report_service.build_assessment(
        original_filename,
        destination,
        regions,
        segmentation_provider,
    )


def _enforce_rate_limit(request: Request) -> None:
    client_host = request.client.host if request.client else "unknown"
    now = monotonic()
    window_start = now - RATE_LIMIT_WINDOW_SECONDS
    recent = [timestamp for timestamp in _request_log.get(client_host, []) if timestamp >= window_start]

    if len(recent) >= RATE_LIMIT_MAX_REQUESTS:
        raise HTTPException(status_code=429, detail="Too many assessment requests. Try again shortly.")

    recent.append(now)
    _request_log[client_host] = recent


def _enforce_optional_api_token(request: Request) -> None:
    if not API_ACCESS_TOKEN:
        return

    auth_header = request.headers.get("authorization", "")
    scheme, _, token = auth_header.partition(" ")
    if scheme.lower() != "bearer" or not compare_digest(token, API_ACCESS_TOKEN):
        raise HTTPException(status_code=401, detail="Invalid or missing API access token.")


def _validate_upload_size(content: bytes) -> None:
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded image is empty.")
    if len(content) > MAX_UPLOAD_BYTES:
        max_mb = MAX_UPLOAD_BYTES / (1024 * 1024)
        raise HTTPException(status_code=413, detail=f"Image must be smaller than {max_mb:.0f} MB.")


def _validate_content_length(request: Request) -> None:
    header = request.headers.get("content-length")
    if not header:
        return

    try:
        content_length = int(header)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid Content-Length header.") from None

    # Multipart overhead is small, but allow a little room above the raw image limit.
    if content_length > MAX_UPLOAD_BYTES + 1024 * 1024:
        max_mb = MAX_UPLOAD_BYTES / (1024 * 1024)
        raise HTTPException(status_code=413, detail=f"Image must be smaller than {max_mb:.0f} MB.")


async def _read_limited_upload(file: UploadFile) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            max_mb = MAX_UPLOAD_BYTES / (1024 * 1024)
            raise HTTPException(status_code=413, detail=f"Image must be smaller than {max_mb:.0f} MB.")
        chunks.append(chunk)
    return b"".join(chunks)


def _validate_image_content(content: bytes) -> bytes:
    try:
        with Image.open(BytesIO(content)) as image:
            image.verify()
        with Image.open(BytesIO(content)) as image:
            if image.format not in {"JPEG", "PNG", "WEBP"}:
                raise HTTPException(status_code=400, detail="Unsupported image encoding.")
            width, height = image.size
            if width * height > MAX_IMAGE_PIXELS:
                raise HTTPException(status_code=413, detail="Image dimensions are too large.")
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError):
        raise HTTPException(status_code=400, detail="Uploaded file is not a valid image.") from None

    return content


def _safe_display_filename(filename: str) -> str:
    normalized = filename.replace("\\", "/")
    name = Path(normalized).name.strip() or "claim-image"
    name = _SAFE_FILENAME_PATTERN.sub("_", name)
    return name[:120] or "claim-image"
