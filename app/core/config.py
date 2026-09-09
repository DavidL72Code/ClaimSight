import os
from pathlib import Path

# python-dotenv is a declared dependency and .env.example documents this file,
# but nothing loaded it, so a local .env was silently ignored. Real environment
# variables still win: load_dotenv does not override what is already set, which
# keeps Hugging Face / Vercel secrets authoritative in deployment.
try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
except Exception:  # pragma: no cover - dotenv missing is non-fatal
    pass


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _env_str(name: str, default: str = "") -> str:
    """A variable present but blank means "unset", not "empty string".

    .env files habitually carry blank placeholders (CASE_DB_PATH=), and
    os.getenv would hand back "" and skip the default -- which turned
    Path("") into a broken database path.
    """
    value = os.getenv(name)
    if value is None:
        return default
    value = value.strip()
    return value or default


def _env_int(name: str, default: int) -> int:
    raw = _env_str(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
CASE_DB_PATH = Path(_env_str("CASE_DB_PATH", str(DATA_DIR / "claimsight.db"))).expanduser()

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
CASE_DB_PATH.parent.mkdir(parents=True, exist_ok=True)

APP_ENV = _env_str("APP_ENV", "development").lower()
DEBUG = _env_bool("DEBUG", False)
ENABLE_API_DOCS = _env_bool("ENABLE_API_DOCS", APP_ENV != "production")
API_ACCESS_TOKEN = os.getenv("API_ACCESS_TOKEN", "").strip()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = _env_str("GEMINI_MODEL", "gemini-3.5-flash-lite")
CLAIM_ASSISTANT_MODEL = _env_str("CLAIM_ASSISTANT_MODEL", "gemini-3.5-flash-lite")
# Free web-search grounding (1000 searches/month free): https://tavily.com
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "").strip()
# Assessment quality controls.
# The evaluator adds one model call per assessment; each retry adds one more.
# Both are on by default but can be disabled to cut latency and cost.
ENABLE_ASSESSMENT_EVALUATOR = _env_bool("ENABLE_ASSESSMENT_EVALUATOR", True)
ENABLE_ASSESSMENT_RETRY = _env_bool("ENABLE_ASSESSMENT_RETRY", True)
MAX_ASSESSMENT_RETRIES = max(0, _env_int("MAX_ASSESSMENT_RETRIES", 1))
# Judging and second-pass review are text-only, so a cheaper model is fine.
EVALUATOR_MODEL = _env_str("EVALUATOR_MODEL") or CLAIM_ASSISTANT_MODEL
SECOND_PASS_MODEL = _env_str("SECOND_PASS_MODEL") or CLAIM_ASSISTANT_MODEL
# Per-node models. Gemini quotas are per-model, so pointing the busy nodes at
# a high-RPD model and reserving a scarce one for rare, high-value calls
# spreads load instead of piling every request onto a single limit.
# Narrative writing is text-only reasoning over already-structured findings.
SUMMARY_MODEL = _env_str("SUMMARY_MODEL") or CLAIM_ASSISTANT_MODEL
# Grounded search draws on its own quota; isolating it keeps a search
# exhaustion from also consuming the detection model's budget.
GROUNDING_MODEL = _env_str("GROUNDING_MODEL") or GEMINI_MODEL
# Escalation model for the self-correction retry only. The first detection
# pass runs on the cheap high-RPD model; a stronger model is spent only when
# that pass produced something the rules layer flagged, which is rare.
RETRY_DETECTION_MODEL = _env_str("RETRY_DETECTION_MODEL") or GEMINI_MODEL

# ── demo reviewer ────────────────────────────────────────────────────────────
# A public demo has no staff on shift, so nothing ever moves a claim past
# "submitted" and every interesting screen stays empty. With DEMO_MODE on, the
# customer can trigger a model-driven review that performs the adjuster's
# workflow server-side and records each step, so the employee portal shows the
# same process a person would have produced.
#
# Off by default and guarded at the route. Point a demo deployment at its OWN
# Firebase project: the reviewer writes employee-only fields, and a manager
# claim can read every case in a project.
DEMO_MODE = _env_bool("DEMO_MODE", False)
DEMO_REVIEWER_EMAIL = _env_str("DEMO_REVIEWER_EMAIL", "demo.reviewer@claimsight.com")
DEMO_REVIEWER_NAME = _env_str("DEMO_REVIEWER_NAME", "Demo Reviewer")
# Seconds of dwell recorded against each step. Real review is not instant, and
# a visible pending -> reviewed transition is most of what the demo is showing.
DEMO_REVIEW_STEP_SECONDS = max(0, _env_int("DEMO_REVIEW_STEP_SECONDS", 2))
DEMO_REVIEWER_MODEL = _env_str("DEMO_REVIEWER_MODEL") or SECOND_PASS_MODEL

SEGMENTATION_PROVIDER = _env_str("SEGMENTATION_PROVIDER", "gemini").lower()
# Optional MobileSAM (ONNX, CPU) mask refiner layered on Gemini's boxes.
ENABLE_SAM2_ONNX = _env_bool("ENABLE_SAM2_ONNX", False)
MOBILESAM_ONNX_REPO = os.getenv("MOBILESAM_ONNX_REPO", "").strip()
MOBILESAM_ENCODER_FILE = _env_str("MOBILESAM_ENCODER_FILE", "mobile_sam.encoder.onnx")
MOBILESAM_DECODER_FILE = _env_str("MOBILESAM_DECODER_FILE", "mobile_sam.decoder.onnx")
ALLOW_CORS_WILDCARD = _env_bool("ALLOW_CORS_WILDCARD", False)
_raw_allowed_origins = [
    origin.strip()
    for origin in os.getenv(
        "ALLOWED_ORIGINS",
        "http://127.0.0.1:4173,http://localhost:4173,http://127.0.0.1:5180,http://localhost:5180",
    ).split(",")
    if origin.strip()
]
ALLOWED_ORIGINS = [
    origin for origin in _raw_allowed_origins if origin != "*" or ALLOW_CORS_WILDCARD
] or ["http://127.0.0.1:4173", "http://localhost:4173"]
ALLOWED_HOSTS = [
    host.strip()
    for host in os.getenv(
        "ALLOWED_HOSTS",
        "127.0.0.1,localhost,testserver,*.hf.space",
    ).split(",")
    if host.strip()
]
MAX_UPLOAD_BYTES = _env_int("MAX_UPLOAD_BYTES", 8 * 1024 * 1024)
MAX_IMAGE_PIXELS = _env_int("MAX_IMAGE_PIXELS", 12_000_000)
RATE_LIMIT_WINDOW_SECONDS = _env_int("RATE_LIMIT_WINDOW_SECONDS", 60)
RATE_LIMIT_MAX_REQUESTS = _env_int("RATE_LIMIT_MAX_REQUESTS", 5)
# Reject /api/assess requests whose Origin/Referer isn't in ALLOWED_ORIGINS.
# Opt-in (default off) so it can't break the live site until the real domain is allowlisted.
ENFORCE_ORIGIN = _env_bool("ENFORCE_ORIGIN", False)

# ---------------------------------------------------------------------------
# Supabase Storage — holds claim attachments (supporting documents, message
# attachments, reviewer evidence). Firebase Storage needs the Blaze plan to
# provision a bucket, so attachments live here instead while Auth and
# Firestore stay on Firebase.
#
# The service key is a full-access credential and never reaches the browser:
# uploads go through POST /api/attachments, which verifies the caller's
# Firebase ID token first.
# ---------------------------------------------------------------------------
SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "").strip()
SUPABASE_ATTACHMENT_BUCKET = _env_str("SUPABASE_ATTACHMENT_BUCKET", "claim-attachments")
# Sent as the apikey header on PostgREST calls. Public by design -- RLS,
# not this key, decides what a request may see.
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "").strip()
# Only needed on projects still using the legacy symmetric JWT secret.
# Newer projects sign with rotating asymmetric keys, which are verified
# against the JWKS endpoint instead and need no secret here.
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "").strip()
# Signed download URLs expire; the frontend re-requests one when a link is opened.
ATTACHMENT_URL_TTL_SECONDS = _env_int("ATTACHMENT_URL_TTL_SECONDS", 60 * 60 * 24 * 7)
