"""Tests for ``make_subagent_bus`` env-driven transport selection."""

import pytest

from gradientbang.adapters.bus import AsyncQueueBus, make_subagent_bus


@pytest.mark.unit
class TestMakeSubagentBus:
    def test_unset_env_returns_local_bus(self, monkeypatch):
        monkeypatch.delenv("SUBAGENT_BUS_TRANSPORT", raising=False)
        assert isinstance(make_subagent_bus(), AsyncQueueBus)

    def test_explicit_local_returns_local_bus(self, monkeypatch):
        monkeypatch.setenv("SUBAGENT_BUS_TRANSPORT", "local")
        assert isinstance(make_subagent_bus(), AsyncQueueBus)

    def test_transport_value_is_case_insensitive_and_trimmed(self, monkeypatch):
        monkeypatch.setenv("SUBAGENT_BUS_TRANSPORT", "  LOCAL  ")
        assert isinstance(make_subagent_bus(), AsyncQueueBus)

    def test_invalid_transport_raises_with_helpful_message(self, monkeypatch):
        monkeypatch.setenv("SUBAGENT_BUS_TRANSPORT", "carrier-pigeon")
        with pytest.raises(ValueError, match="carrier-pigeon"):
            make_subagent_bus()

    def test_pgmq_branch_not_yet_implemented(self, monkeypatch):
        # Wired in Phase 2 (4/N). Until then, fail loudly so accidental
        # deployments don't silently fall back to the local bus.
        monkeypatch.setenv("SUBAGENT_BUS_TRANSPORT", "pgmq")
        with pytest.raises(NotImplementedError):
            make_subagent_bus()
