import pytest

from gradientbang.config import Settings

pytestmark = pytest.mark.unit


def test_empty_env_values_are_ignored_and_defaults_apply(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CEKURA_TRACER_ENABLED", "")
    monkeypatch.setenv("BOT_NEW_PLAYER_ONBOARDING", "")
    monkeypatch.setenv("TOKEN_USAGE_LOG", "")

    settings = Settings()

    assert settings.CEKURA_TRACER_ENABLED is False
    assert settings.BOT_NEW_PLAYER_ONBOARDING is True
    assert settings.TOKEN_USAGE_LOG is None


def test_cekura_tracing_requires_explicit_true(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CEKURA_TRACER_ENABLED", raising=False)
    assert Settings().CEKURA_TRACER_ENABLED is False

    monkeypatch.setenv("CEKURA_TRACER_ENABLED", "true")
    assert Settings().CEKURA_TRACER_ENABLED is True
