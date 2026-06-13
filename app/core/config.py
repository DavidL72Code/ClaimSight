import os
from pathlib import Path


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "data"
UPLOAD_DIR = DATA_DIR / "uploads"

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

APP_ENV = os.getenv("APP_ENV", "development").strip().lower()
DEBUG = _env_bool("DEBUG", False)
ENABLE_API_DOCS = _env_bool("ENABLE_API_DOCS", APP_ENV != "production")
API_ACCESS_TOKEN = os.getenv("API_ACCESS_TOKEN", "").strip()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash").strip()
SEGMENTATION_PROVIDER = os.getenv("SEGMENTATION_PROVIDER", "sam2").strip().lower()
SAM2_MODEL_ID = os.getenv("SAM2_MODEL_ID", "facebook/sam2-hiera-tiny").strip()
ALLOW_CORS_WILDCARD = _env_bool("ALLOW_CORS_WILDCARD", False)
_raw_allowed_origins = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "http://127.0.0.1:4173,http://localhost:4173").split(",")
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
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(8 * 1024 * 1024)))
MAX_IMAGE_PIXELS = int(os.getenv("MAX_IMAGE_PIXELS", str(12_000_000)))
RATE_LIMIT_WINDOW_SECONDS = int(os.getenv("RATE_LIMIT_WINDOW_SECONDS", "60"))
RATE_LIMIT_MAX_REQUESTS = int(os.getenv("RATE_LIMIT_MAX_REQUESTS", "12"))
