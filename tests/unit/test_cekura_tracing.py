import pytest

from gradientbang.utils import cekura_tracing

pytestmark = pytest.mark.unit


def test_init_cekura_disabled_does_not_parse_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(cekura_tracing, "_tracer", None)
    monkeypatch.setattr(cekura_tracing.settings, "CEKURA_TRACER_ENABLED", False)
    monkeypatch.setattr(cekura_tracing.settings, "CEKURA_API_KEY", "key")
    monkeypatch.setattr(cekura_tracing.settings, "CEKURA_AGENT_ID", "not-an-int")

    assert cekura_tracing.init_cekura() is None
    assert cekura_tracing.is_cekura_enabled() is False
