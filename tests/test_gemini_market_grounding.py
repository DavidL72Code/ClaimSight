from app.services.gemini_client import GeminiClaimNarrator


def test_resolve_grounded_value_prefers_median_of_comparable_prices() -> None:
    narrator = GeminiClaimNarrator()

    grounded_value, methodology = narrator._resolve_grounded_value(
        label="2020 McLaren 720S",
        prices=[198000, 205000, 212000],
        model_value=115000,
        model_methodology="Model selected weaker comps.",
    )

    assert grounded_value == 205000
    assert "$198,000" in methodology
    assert "$205,000" in methodology
    assert "$212,000" in methodology
    assert "median comparable price of $205,000" in methodology


def test_resolve_grounded_value_keeps_model_value_when_too_few_comparables() -> None:
    narrator = GeminiClaimNarrator()

    grounded_value, methodology = narrator._resolve_grounded_value(
        label="2020 McLaren 720S",
        prices=[198000],
        model_value=202000,
        model_methodology="Used one matched listing and a market reference.",
    )

    assert grounded_value == 202000
    assert "weaker grounded fallback" in methodology
