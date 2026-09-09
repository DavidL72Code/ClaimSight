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
    DEMO_MODE,
    ENFORCE_ORIGIN,
    MAX_IMAGE_PIXELS,
    MAX_UPLOAD_BYTES,
    RATE_LIMIT_MAX_REQUESTS,
    RATE_LIMIT_WINDOW_SECONDS,
    SECOND_PASS_MODEL,
    SEGMENTATION_PROVIDER,
    UPLOAD_DIR,
    CLAIM_ASSISTANT_MODEL,
)
from app.models.schemas import AssessmentResponse, CaseSavePayload, ClaimContext
from app.models.schemas import ClaimAssistantRequest, ClaimAssistantResponse
from app.models.schemas import SecondPassRequest, SecondPassResponse
from app.models.schemas import DemoReviewRequest, DemoReviewResponse, DemoReplyResponse
from app.services.assessment_pipeline import AssessmentPipeline
from app.services.attachment_storage import (
    ALLOWED_ATTACHMENT_TYPES,
    ATTACHMENT_FOLDERS,
    AttachmentStorageError,
    SupabaseAttachmentStorage,
)
from app.services.case_repository import CaseRepository
from app.services.demo_reviewer import DemoReviewer, DemoReviewerError
from app.services.evaluation import AssessmentEvaluator
from app.services.firebase_claims import FirebaseClaimLookup
from app.services.gemini_client import GeminiClaimNarrator
from app.services.report_generation import ClaimReportService
from app.services.segmentation import get_segmentation_service
from app.services.supabase_auth import SupabaseAuth
from app.services.supabase_data import SupabaseData, SupabaseDataError

router = APIRouter()

segmentation_service = get_segmentation_service()
report_service = ClaimReportService()
case_repository = CaseRepository()
claim_assistant = GeminiClaimNarrator()
firebase_claim_lookup = FirebaseClaimLookup()
attachment_storage = SupabaseAttachmentStorage()
supabase_auth = SupabaseAuth()
supabase_data = SupabaseData()
assessment_evaluator = AssessmentEvaluator(
    narrator=getattr(segmentation_service, "narrator", None) or claim_assistant
)
assessment_pipeline = AssessmentPipeline(
    segmentation_service, report_service, assessment_evaluator
)
# Demo-only stand-in for the human adjuster; every route using it is gated on
# DEMO_MODE, so constructing it in production costs nothing.
demo_reviewer = DemoReviewer(narrator=claim_assistant, claim_lookup=firebase_claim_lookup)

ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
ALLOWED_MIME_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_IMAGES_PER_REQUEST = 8
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
_request_log: dict[str, list[float]] = {}
# Cheapest useful keepalive cadence: an uptime monitor on a 5 minute
# schedule then reaches Supabase once per poll and no more.
KEEPALIVE_MIN_INTERVAL_SECONDS = 240
_keepalive_cache: dict[str, object] = {}
_SAFE_FILENAME_PATTERN = re.compile(r"[^A-Za-z0-9._ -]+")
_EMPTY_DAMAGE_VALUES = {"", "n/a", "na", "none", "no", "none reported", "no prior damage"}


def _health_payload() -> dict[str, object]:
    payload: dict[str, object] = {
        "status": "ok",
        "segmentation_provider": SEGMENTATION_PROVIDER,
        "active_segmentation_provider": segmentation_service.provider_name,
        # Lets a client tell a demo deployment from a real one without having
        # to probe /api/demo/review and interpret a 404.
        "demo_mode": DEMO_MODE,
        # Lets the frontend hide attachment controls instead of throwing
        # when no storage backend is configured.
        "attachments_enabled": attachment_storage.ready,
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
    decoded_token = _require_firebase_user(request)
    _enforce_rate_limit(request, identity=str(decoded_token.get("uid") or ""))

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
        return assessment_pipeline.run(filenames, destinations, claim_context)
    finally:
        # Don't retain claim photos on the server after the assessment is built.
        for path in destinations:
            try:
                path.unlink(missing_ok=True)
            except Exception:
                pass


@router.post("/api/cases")
def save_case(request: Request, payload: CaseSavePayload) -> dict[str, object]:
    _require_employee(request)
    return case_repository.save_case(payload)


@router.get("/api/cases")
def list_cases(request: Request, limit: int = 25) -> dict[str, object]:
    _require_employee(request)
    normalized_limit = min(max(limit, 1), 100)
    return {"cases": case_repository.list_cases(normalized_limit)}


@router.get("/api/cases/{case_id}")
def get_case(request: Request, case_id: str) -> dict[str, object]:
    _require_employee(request)
    payload = case_repository.get_case(case_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="Case not found.")
    return payload


@router.get("/api/queue")
def triage_queue(request: Request, limit: int = 25) -> dict[str, object]:
    _require_employee(request)
    normalized_limit = min(max(limit, 1), 100)
    return {"cases": case_repository.list_queue(normalized_limit)}


@router.post("/api/claim-assistant", response_model=ClaimAssistantResponse)
def ask_claim_assistant(request: Request, payload: ClaimAssistantRequest) -> ClaimAssistantResponse:
    _enforce_origin_allowlist(request)
    _enforce_optional_api_token(request)

    decoded_token = _require_firebase_user(request)
    _enforce_rate_limit(request, identity=str(decoded_token.get("uid") or ""))
    owned_context = firebase_claim_lookup.get_owned_claim_context(
        uid=str(decoded_token.get("uid") or ""),
        claim_reference=payload.context.claim_reference,
    )
    if not owned_context:
        # Do not reveal whether a claim exists when it is not owned by this user.
        raise HTTPException(status_code=404, detail="Claim not found.")

    context = {
        **owned_context,
        "page_title": payload.context.page_title,
        "customer_profile": {
            "email": decoded_token.get("email") or "",
            "name": decoded_token.get("name") or "",
        },
    }

    history = [message.model_dump() for message in payload.history][-8:]
    answer = claim_assistant.answer_claim_assistant(payload.message, context, history)

    if not answer:
        answer = _safe_assistant_fallback(payload.message, context)
        return ClaimAssistantResponse(answer=answer, model="rules", fallback_used=True)

    return ClaimAssistantResponse(
        answer=answer,
        model=CLAIM_ASSISTANT_MODEL,
        fallback_used=False,
    )


@router.post("/api/second-pass", response_model=SecondPassResponse)
def second_pass_review(request: Request, payload: SecondPassRequest) -> SecondPassResponse:
    """Re-reason over an assessment after a human adjuster challenges it.

    Adjuster-only: this returns internal reasoning about whether the claim
    handler's revised estimate should displace the AI's.
    """
    _enforce_origin_allowlist(request)
    _enforce_optional_api_token(request)

    decoded_token = _require_employee(request)
    _enforce_rate_limit(request, identity=str(decoded_token.get("uid") or ""))

    result = claim_assistant.second_pass_review(payload.model_dump())

    if not result or not str(result.get("reasoning") or "").strip():
        return SecondPassResponse(
            reasoning=_second_pass_fallback(payload),
            agrees_with_adjuster=False,
            recommended_action=payload.proposed_final_action or "Adjuster review required",
            model="rules",
            fallback_used=True,
        )

    return SecondPassResponse(
        reasoning=str(result.get("reasoning"))[:2000],
        agrees_with_adjuster=bool(result.get("agrees_with_adjuster")),
        recommended_action=str(result.get("recommended_action") or "")[:200],
        model=SECOND_PASS_MODEL,
        fallback_used=False,
    )


def _demo_guard(request: Request) -> None:
    """Shared gate for every demo route.

    404 rather than 403 when DEMO_MODE is off, so a production deployment is
    indistinguishable from one where these routes were never written.
    """
    if not DEMO_MODE:
        raise HTTPException(status_code=404, detail="Not found.")
    _enforce_origin_allowlist(request)
    _enforce_optional_api_token(request)
    if not demo_reviewer.ready:
        raise HTTPException(
            status_code=503,
            detail="Demo review is unavailable because Firebase Admin is not configured.",
        )


def _demo_error(exc: DemoReviewerError) -> HTTPException:
    message = str(exc)
    lowered = message.lower()
    if "not found" in lowered:
        return HTTPException(status_code=404, detail=message)
    return HTTPException(status_code=409, detail=message)


@router.get("/api/keepalive")
def keepalive(request: Request) -> dict[str, object]:
    """Reach through to Supabase so an uptime monitor keeps it from pausing.

    Supabase pauses free projects after roughly a week of inactivity and
    restoring one is a manual click in their dashboard, so a monitor has to
    touch the project rather than just this app. /api/health deliberately
    does not make any outbound calls, which is why this is a separate route:
    pinging health would keep the Space warm but let Supabase pause anyway.

    Unauthenticated, because an uptime monitor cannot hold a Firebase token.
    That makes it a small outbound-request amplifier, so the result is cached
    and Supabase is touched at most once per KEEPALIVE_MIN_INTERVAL_SECONDS
    no matter how often this is called.
    """
    _enforce_rate_limit(request)

    now = monotonic()
    cached = _keepalive_cache.get("checked_at")
    if cached is not None and (now - cached) < KEEPALIVE_MIN_INTERVAL_SECONDS:
        reached = bool(_keepalive_cache.get("reached"))
        detail = str(_keepalive_cache.get("detail") or "")
        cache_state = "hit"
    else:
        reached, detail = attachment_storage.ping()
        _keepalive_cache.update({"checked_at": now, "reached": reached, "detail": detail})
        cache_state = "miss"

    payload: dict[str, object] = {
        "status": "ok" if (reached or detail == "not_configured") else "degraded",
        "supabase": detail,
        "cache": cache_state,
    }

    # Only alert once storage is actually configured: an unconfigured
    # deployment is a deliberate state, not an outage to page someone about.
    if not reached and detail != "not_configured":
        raise HTTPException(status_code=503, detail=f"Supabase {detail}.")
    return payload


@router.post("/api/attachments")
async def upload_attachment(
    request: Request,
    case_id: str = Form(...),
    folder: str = Form(...),
    file: UploadFile = File(...),
) -> dict[str, object]:
    """Store one claim attachment and hand back a signed download URL.

    Firebase Storage would have enforced access with storage.rules, but it
    needs the Blaze plan to provision a bucket. Attachments go to Supabase
    instead, which means the ownership check that storage.rules used to do
    has to happen here -- see describe_case_access, which ports it.
    """
    decoded_token = _require_user(request)
    _enforce_rate_limit(request, str(decoded_token.get("uid") or ""))

    if folder not in ATTACHMENT_FOLDERS:
        raise HTTPException(status_code=400, detail="Unknown attachment folder.")

    if not attachment_storage.ready:
        raise HTTPException(
            status_code=503,
            detail="Attachment storage is not configured on this deployment.",
        )

    # Access is decided by RLS, not here: the case is fetched with the
    # caller's own token, so the select policy in supabase/migrations answers
    # whether they may see it at all. On the Firebase path the Admin SDK
    # bypassed rules, so the equivalent check had to be hand-written.
    if decoded_token.get("provider") == "supabase" and supabase_data.ready:
        try:
            access = supabase_data.describe_case_access(
                access_token=_bearer_token(request),
                case_id=case_id,
                uid=str(decoded_token.get("uid") or ""),
                email=str(decoded_token.get("email") or ""),
                role=str(decoded_token.get("role") or ""),
            )
        except SupabaseDataError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        # Invisible and absent are the same answer on purpose -- replying
        # differently would reveal whether a claim id exists to someone with
        # no right to know.
        if not access["visible"]:
            raise HTTPException(status_code=404, detail="Case not found.")
    else:
        access = firebase_claim_lookup.describe_case_access(
            case_id=case_id,
            uid=str(decoded_token.get("uid") or ""),
            email=str(decoded_token.get("email") or ""),
            role=str(decoded_token.get("role") or ""),
        )
        if not access["exists"]:
            raise HTTPException(status_code=404, detail="Case not found.")
        if not access["allowed"]:
            raise HTTPException(status_code=403, detail="You do not have access to this case.")
    # Only the assigned adjuster (or a manager) may file reviewer evidence;
    # storage.rules drew the same line on claim-reviewer-evidence.
    if folder == "reviewer-evidence" and not (
        access["is_assigned_employee"] or access["is_manager"]
    ):
        raise HTTPException(
            status_code=403, detail="Only the assigned adjuster can add reviewer evidence."
        )

    content_type = (file.content_type or "").split(";")[0].strip().lower()
    if content_type not in ALLOWED_ATTACHMENT_TYPES:
        raise HTTPException(status_code=415, detail="That file type is not supported.")

    content = await file.read()
    _validate_upload_size(content)

    try:
        stored = attachment_storage.upload(
            folder_key=folder,
            case_id=case_id,
            filename=file.filename or "attachment",
            content=content,
            content_type=content_type,
        )
    except AttachmentStorageError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return {
        "name": file.filename or "attachment",
        "download_url": stored["download_url"],
        "path": stored["path"],
        "content_type": content_type,
        "size_bytes": len(content),
    }


@router.post("/api/demo/enroll", response_model=DemoReviewResponse)
def demo_enroll(request: Request, payload: DemoReviewRequest) -> DemoReviewResponse:
    """Assign a newly submitted claim to the demo reviewer. Demo only.

    Called by the customer straight after submission. The employee queue filters
    on assigned_agent.email, so the claim has to be assigned before it is
    visible in the employee portal -- otherwise there is nothing to step through.

    Owner-callable, and ownership is re-checked in the service before it writes.
    A claim the caller does not own returns the same 404 as one that does not
    exist, so this cannot enumerate case ids.
    """
    _demo_guard(request)
    decoded_token = _require_firebase_user(request)
    uid = str(decoded_token.get("uid") or "")
    _enforce_rate_limit(request, identity=uid)

    try:
        return DemoReviewResponse(**demo_reviewer.enroll(case_id=payload.case_id, owner_uid=uid))
    except DemoReviewerError as exc:
        raise _demo_error(exc) from exc


@router.post("/api/demo/review/step", response_model=DemoReviewResponse)
def demo_review_step(request: Request, payload: DemoReviewRequest) -> DemoReviewResponse:
    """Advance the simulated adjuster by exactly one step. Demo only.

    Driven from the employee portal so a viewer can walk the review one click at
    a time and watch the customer side react to each step. Employee-gated: this
    is the adjuster's side of the workflow, and it writes employee-only fields.
    """
    _demo_guard(request)
    decoded_token = _require_employee(request)
    _enforce_rate_limit(request, identity=str(decoded_token.get("uid") or ""))

    try:
        return DemoReviewResponse(**demo_reviewer.advance(case_id=payload.case_id))
    except DemoReviewerError as exc:
        raise _demo_error(exc) from exc


@router.post("/api/demo/review/status", response_model=DemoReviewResponse)
def demo_review_status(request: Request, payload: DemoReviewRequest) -> DemoReviewResponse:
    """Where the step-through has got to, for rendering the next-step control."""
    _demo_guard(request)
    _require_employee(request)

    try:
        return DemoReviewResponse(**demo_reviewer.status(case_id=payload.case_id))
    except DemoReviewerError as exc:
        raise _demo_error(exc) from exc


@router.post("/api/demo/reply", response_model=DemoReplyResponse)
def demo_reply(request: Request, payload: DemoReviewRequest) -> DemoReplyResponse:
    """Answer the customer's latest message in character. Demo only.

    Completes the loop the other way: the viewer writes as the customer in one
    tab, triggers this from the employee tab, and a real reply lands in the
    thread with a notification.
    """
    _demo_guard(request)
    decoded_token = _require_employee(request)
    _enforce_rate_limit(request, identity=str(decoded_token.get("uid") or ""))

    try:
        return DemoReplyResponse(**demo_reviewer.reply_to_customer(case_id=payload.case_id))
    except DemoReviewerError as exc:
        raise _demo_error(exc) from exc


def _second_pass_fallback(payload: SecondPassRequest) -> str:
    """Deterministic summary used when the model is unavailable.

    Explicitly labelled as not-AI so the UI never implies a model reviewed the
    challenge when none did.
    """
    vehicle = payload.vehicle or "the submitted vehicle"
    challenge = payload.adjuster_challenge or "no specific challenge was entered"
    delta = payload.reviewed_estimate_usd - payload.ai_estimate_usd
    direction = (
        f"raises the estimate by ${delta:,}" if delta > 0
        else f"lowers the estimate by ${abs(delta):,}" if delta < 0
        else "leaves the estimate unchanged"
    )
    return (
        f"Automated model review is unavailable, so this is a rules-based summary, not an AI second pass. "
        f"For {vehicle}, the adjuster's challenge was: {challenge}. "
        f"The reviewed estimate of ${payload.reviewed_estimate_usd:,} {direction} "
        f"versus the AI estimate of ${payload.ai_estimate_usd:,}. "
        "Re-check visible damage, the customer statement, photo evidence, and hidden-damage risk "
        "before recording a final judgement."
    )


def _safe_assistant_fallback(message: str, context: dict[str, object]) -> str:
    question = message.lower()
    claim_reference = str(context.get("claim_reference") or "this claim")
    status = str(context.get("status") or "not selected yet")
    vehicle = str(context.get("vehicle") or "")
    profile = context.get("customer_profile") if isinstance(context.get("customer_profile"), dict) else {}
    customer_name = str(profile.get("name") or "").strip()
    reviewed_total = int(context.get("reviewed_total_cost_usd") or 0)
    estimated_total = int(context.get("estimated_total_cost_usd") or 0)

    if any(word in question for word in ["payout", "pay", "guarantee", "approve"]):
        return (
            f"I cannot promise payout, approval, or coverage. {claim_reference} is currently "
            f"marked as {status}. The official decision must come from the adjuster and final report."
        )
    if any(word in question for word in ["amount", "estimate", "cost", "total"]):
        if reviewed_total:
            return f"The verified reviewed estimate visible for {claim_reference} is ${reviewed_total:,}. This is not a payment promise or coverage decision."
        if estimated_total:
            return f"The verified AI estimate visible for {claim_reference} is ${estimated_total:,}. This is not a payment promise or coverage decision."
        return "I do not have a verified claim amount in the current context. Check the final report or message the adjuster."
    if any(word in question for word in ["model", "vehicle", "car", "make", "trim"]):
        return f"The verified vehicle shown for {claim_reference} is {vehicle}." if vehicle else "I do not have verified vehicle details in the current context."
    if "name" in question:
        return f"The signed-in customer name I can verify is {customer_name}." if customer_name else "I do not have a verified customer name in the current context."
    if any(word in question for word in ["appeal", "dispute", "wrong"]):
        return "If you disagree, use the appeal option during final review and include clear photos, repair notes, receipts, and a short explanation of what you believe is missing."
    if any(word in question for word in ["evidence", "photo", "document", "upload"]):
        return "Helpful evidence includes wide photos, close-ups, VIN/odometer photos, repair estimates, police reports, tow bills, and notes about prior damage."
    if "status" in question or "progress" in question:
        return f"{claim_reference} is currently marked as {status}. Submitted or in-review claims can still add evidence and message the adjuster."
    return "I can explain claim status, evidence, appeals, reports, and visible reasoning. I cannot change a decision or promise payment."


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


def _enforce_rate_limit(request: Request, identity: str = "") -> None:
    client_host = f"uid:{identity}" if identity else f"ip:{_client_ip(request)}"
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


def _bearer_token(request: Request) -> str:
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    return token if scheme.lower() == "bearer" else ""


def _require_user(request: Request) -> dict[str, object]:
    """Identify the caller, preferring Supabase over Firebase.

    Both are accepted while the migration is in flight, so a deployment can
    move without a flag day. Supabase is tried first: once its credentials
    are present it is the real identity provider, and the Firebase branch is
    dead code waiting to be deleted.

    The returned shape is uniform -- uid, email, role -- so call sites do not
    care which provider answered.
    """
    authorization = request.headers.get("authorization", "")

    claims = supabase_auth.verify_bearer_token(authorization)
    if claims:
        return {**claims, "provider": "supabase"}

    decoded_token = firebase_claim_lookup.verify_bearer_token(authorization)
    if decoded_token:
        return {
            "uid": str(decoded_token.get("uid") or ""),
            "email": str(decoded_token.get("email") or ""),
            "role": str(decoded_token.get("role") or ""),
            "provider": "firebase",
            "raw": decoded_token,
        }

    raise HTTPException(status_code=401, detail="Valid authentication is required.")


# Kept as an alias so existing call sites read the same; both providers are
# accepted, so the Firebase-specific name would now be misleading.
def _require_firebase_user(request: Request) -> dict[str, object]:
    return _require_user(request)


def _require_employee(request: Request) -> dict[str, object]:
    decoded_token = _require_firebase_user(request)
    if decoded_token.get("role") not in {"employee", "manager", "admin"}:
        raise HTTPException(status_code=403, detail="Employee access is required.")
    return decoded_token


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
