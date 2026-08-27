"""Environment parsing: a variable that is present but blank means "unset".

.env files habitually carry blank placeholders (CASE_DB_PATH=), and the
plain os.getenv(name, default) form hands back "" instead of the default.
That turned Path("") into an unopenable sqlite path and would raise on
int("") for the numeric limits.
"""

import importlib

import pytest

import app.core.config as config


def _reload(monkeypatch, **env):
    for key, value in env.items():
        if value is None:
            monkeypatch.delenv(key, raising=False)
        else:
            monkeypatch.setenv(key, value)
    # .env would otherwise re-supply the values we are trying to blank out
    monkeypatch.setattr("dotenv.load_dotenv", lambda *a, **k: False, raising=False)
    return importlib.reload(config)


@pytest.fixture(autouse=True)
def _restore():
    yield
    importlib.reload(config)


def test_blank_path_falls_back_to_default(monkeypatch) -> None:
    cfg = _reload(monkeypatch, CASE_DB_PATH="")
    assert cfg.CASE_DB_PATH.name == "claimsight.db"
    assert str(cfg.CASE_DB_PATH) != ""


@pytest.mark.parametrize(
    "name,default",
    [
        ("MAX_UPLOAD_BYTES", 8 * 1024 * 1024),
        ("MAX_IMAGE_PIXELS", 12_000_000),
        ("RATE_LIMIT_WINDOW_SECONDS", 60),
        ("RATE_LIMIT_MAX_REQUESTS", 5),
    ],
)
def test_blank_numeric_falls_back_instead_of_raising(monkeypatch, name, default) -> None:
    cfg = _reload(monkeypatch, **{name: ""})
    assert getattr(cfg, name) == default


def test_unparseable_numeric_falls_back(monkeypatch) -> None:
    cfg = _reload(monkeypatch, RATE_LIMIT_MAX_REQUESTS="not-a-number")
    assert cfg.RATE_LIMIT_MAX_REQUESTS == 5


def test_blank_model_names_fall_back(monkeypatch) -> None:
    cfg = _reload(monkeypatch, GEMINI_MODEL="", EVALUATOR_MODEL="", SECOND_PASS_MODEL="")
    assert cfg.GEMINI_MODEL == "gemini-3.5-flash-lite"
    assert cfg.EVALUATOR_MODEL == cfg.CLAIM_ASSISTANT_MODEL
    assert cfg.SECOND_PASS_MODEL == cfg.CLAIM_ASSISTANT_MODEL


def test_real_env_still_wins_over_defaults(monkeypatch) -> None:
    cfg = _reload(monkeypatch, SEGMENTATION_PROVIDER="MOCK", RATE_LIMIT_MAX_REQUESTS="42")
    assert cfg.SEGMENTATION_PROVIDER == "mock"  # normalised to lowercase
    assert cfg.RATE_LIMIT_MAX_REQUESTS == 42
