"""Tests for ByoaAgentConfig — env parsing and defaults."""

import pytest

from gradientbang.byoa import ByoaAgentConfig


@pytest.mark.unit
class TestDefaults:
    def test_defaults_safe_for_bundled_agent(self):
        cfg = ByoaAgentConfig()
        assert cfg.tool_call_timeout_seconds > 0
        assert cfg.agent_wake_timeout_seconds > 0
        assert cfg.agent_idle_teardown_seconds > 0


@pytest.mark.unit
class TestFromEnv:
    def test_empty_env_returns_defaults(self):
        cfg = ByoaAgentConfig.from_env(env={})
        assert cfg == ByoaAgentConfig()

    def test_env_overrides_apply(self):
        env = {
            "BYOA_TOOL_CALL_TIMEOUT_SECONDS": "12.5",
            "BYOA_AGENT_IDLE_TEARDOWN_SECONDS": "120",
        }
        cfg = ByoaAgentConfig.from_env(env=env)
        assert cfg.tool_call_timeout_seconds == 12.5
        assert cfg.agent_idle_teardown_seconds == 120.0
        # Untouched fields keep defaults.
        assert cfg.agent_wake_timeout_seconds == 30.0

    def test_empty_string_env_falls_back_to_default(self):
        env = {"BYOA_TOOL_CALL_TIMEOUT_SECONDS": ""}
        cfg = ByoaAgentConfig.from_env(env=env)
        assert cfg.tool_call_timeout_seconds == 30.0

    def test_custom_prefix(self):
        env = {"OPS_TOOL_CALL_TIMEOUT_SECONDS": "7.5"}
        cfg = ByoaAgentConfig.from_env(env=env, prefix="OPS_")
        assert cfg.tool_call_timeout_seconds == 7.5

    def test_lifecycle_fields_defaults(self):
        """agent_wake_timeout_seconds and agent_idle_teardown_seconds
        ship with sensible defaults."""
        cfg = ByoaAgentConfig()
        # Generous enough to cover Vercel-Sandbox-class cold starts.
        assert cfg.agent_wake_timeout_seconds == 30.0
        # 5 minutes — short enough that a finished BYOA agent doesn't
        # squat the ship slot indefinitely.
        assert cfg.agent_idle_teardown_seconds == 300.0

    def test_lifecycle_env_overrides(self):
        env = {
            "BYOA_AGENT_WAKE_TIMEOUT_SECONDS": "45.5",
            "BYOA_AGENT_IDLE_TEARDOWN_SECONDS": "120",
        }
        cfg = ByoaAgentConfig.from_env(env=env)
        assert cfg.agent_wake_timeout_seconds == 45.5
        assert cfg.agent_idle_teardown_seconds == 120.0
