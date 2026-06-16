from datetime import datetime
from hmac import compare_digest
from io import BytesIO
from pathlib import Path
import re
from time import monotonic
from typing import Optional
from uuid import uuid4

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from PIL import Image, UnidentifiedImageError

from app.core.config import (
    ALLOWED_ORIGINS,
    API_ACCESS_TOKEN,
    ENFORCE_ORIGIN,
    MAX_IMAGE_PIXELS,
    MAX_UPLOAD_BYTES,
    RATE_LIMIT_MAX_REQUESTS,
    RATE_LIMIT_WINDOW_SECONDS,
    SAM2_MODEL_ID,
    SEGMENTATION_PROVIDER,
    UPLOAD_DIR,
)
from app.models.schemas import AssessmentResponse, ClaimContext
from app.services.report_generation import ClaimReportService
from app.services.segmentation import get_segmentation_service

router = APIRouter()

segmentation_service = get_segmentation_service()
report_service = ClaimReportService()

ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
ALLOWED_MIME_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_IMAGES_PER_REQUEST = 8
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
_request_log: dict[str, list[float]] = {}
_SAFE_FILENAME_PATTERN = re.compile(r"[^A-Za-z0-9._ -]+")
_EMPTY_DAMAGE_VALUES = {"", "n/a", "na", "none", "no", "none reported", "no prior damage"}


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
async def assess_damage(
    request: Request,
    files: list[UploadFile] = File(default=[]),
    file: Optional[UploadFile] = File(default=None),
    make: str = Form(default=""),
    model: str = Form(default=""),
    trim: str = Form(default=""),
    year: Optional[int] = Form(default=None),
    mileage: Optional[int] = Form(default=None),
    pre_existing_damage: str = Form(default=""),
) -> AssessmentResponse:
    _enforce_origin_allowlist(request)
    _enforce_optional_api_token(request)
    _enforce_rate_limit(request)

    # Accept either the multi-image field ("files") or the legacy single field ("file").
    uploads = [upload for upload in files if upload and upload.filename]
    if not uploads and file and file.filename:
        uploads = [file]

    if not uploads:
        raise HTTPException(status_code=400, detail="At least one image file is required.")
    if len(uploads) > MAX_IMAGES_PER_REQUEST:
        raise HTTPException(
            status_code=400,
            detail=f"Upload at most {MAX_IMAGES_PER_REQUEST} images per assessment.",
        )

    _validate_content_length(request, count=len(uploads))

    claim_context = _build_claim_context(
        make=make,
        model=model,
        trim=trim,
        year=year,
        mileage=mileage,
        pre_existing_damage=pre_existing_damage,
    )

    filenames: list[str] = []
    destinations: list[Path] = []
    for upload in uploads:
        original_filename = _safe_display_filename(upload.filename)
        extension = Path(original_filename).suffix.lower()
        if extension not in ALLOWED_EXTENSIONS:
            raise HTTPException(status_code=400, detail="Supported formats: .jpg, .jpeg, .png, .webp")
        if upload.content_type not in ALLOWED_MIME_TYPES:
            raise HTTPException(
                status_code=400, detail="Uploaded files must be JPEG, PNG, or WebP images."
            )

        content = await _read_limited_upload(upload)
        _validate_upload_size(content)
        content = _validate_image_content(content)

        destination = UPLOAD_DIR / f"{uuid4().hex}{extension}"
        destination.write_bytes(content)
        filenames.append(original_filename)
        destinations.append(destination)

    # No caching: every request runs the model fresh (so output reflects the model,
    # not stored memory) and no user's assessment is held in shared server state.
    try:
        regions = segmentation_service.analyze_images(destinations, filenames, claim_context)
        segmentation_provider = (
            regions[0].source if regions else segmentation_service.provider_name
        )
        return report_service.build_assessment(
            filenames,
            destinations,
            regions,
            segmentation_provider,
            claim_context,
        )
    finally:
        # Don't retain claim photos on the server after the assessment is built.
        for path in destinations:
            try:
                path.unlink(missing_ok=True)
            except Exception:
                pass


def _enforce_origin_allowlist(request: Request) -> None:
    """Reject requests not originating from an approved site (cheap deterrent).

    Opt-in via ENFORCE_ORIGIN. Browsers send Origin honestly on cross-site POSTs;
    non-browser tools can forge it, so this stops casual/bot/cross-site abuse, not a
    determined attacker. Disabled by default so it can't break the live site.
    """
    if not ENFORCE_ORIGIN:
        return

    origin = request.headers.get("origin", "").rstrip("/")
    if origin and origin in {o.rstrip("/") for o in ALLOWED_ORIGINS}:
        return

    referer = request.headers.get("referer", "")
    if referer and any(referer.startswith(o) for o in ALLOWED_ORIGINS):
        return

    raise HTTPException(status_code=403, detail="Requests are only accepted from the official app.")


def _client_ip(request: Request) -> str:
    # Behind HF's proxy the socket peer is the proxy, so per-user limiting needs the
    # forwarded client IP. (Forgeable, but so is rotating source IPs — fine for throttling.)
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _enforce_rate_limit(request: Request) -> None:
    client_host = _client_ip(request)
    now = monotonic()
    window_start = now - RATE_LIMIT_WINDOW_SECONDS

    # Evict clients with no recent activity so the log can't grow unboundedly.
    for host in [h for h, ts in _request_log.items() if not ts or ts[-1] < window_start]:
        _request_log.pop(host, None)

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


def _validate_content_length(request: Request, count: int = 1) -> None:
    header = request.headers.get("content-length")
    if not header:
        return

    try:
        content_length = int(header)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid Content-Length header.") from None

    # Per-image cap times the number of images, plus a little multipart overhead room.
    limit = MAX_UPLOAD_BYTES * max(1, count) + 1024 * 1024
    if content_length > limit:
        max_mb = MAX_UPLOAD_BYTES / (1024 * 1024)
        raise HTTPException(
            status_code=413,
            detail=f"Each image must be smaller than {max_mb:.0f} MB.",
        )


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


def _build_claim_context(
    *,
    make: str,
    model: str,
    trim: str,
    year: Optional[int],
    mileage: Optional[int],
    pre_existing_damage: str,
) -> ClaimContext:
    current_year = datetime.now().year
    normalized_year = year
    normalized_mileage = mileage
    max_year = current_year + 1

    if normalized_year is not None and not 1980 <= normalized_year <= max_year:
        raise HTTPException(
            status_code=400,
            detail=f"Vehicle year must be between 1980 and {max_year}.",
        )
    if normalized_mileage is not None and not 0 <= normalized_mileage <= 500000:
        raise HTTPException(status_code=400, detail="Mileage must be between 0 and 500,000.")

    normalized_pre_existing_damage = _normalize_pre_existing_damage(pre_existing_damage)

    return ClaimContext(
        make=make.strip(),
        model=model.strip(),
        trim=trim.strip(),
        year=normalized_year,
        mileage=normalized_mileage,
        pre_existing_damage=normalized_pre_existing_damage,
    )


def _normalize_pre_existing_damage(value: str) -> str:
    normalized = value.strip()
    if normalized.lower() in _EMPTY_DAMAGE_VALUES:
        return ""
    return normalized
