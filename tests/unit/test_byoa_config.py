"""Tests for ByoaAgentConfig — env parsing, defaults, validation."""

import pytest

from gradientbang.byoa import ByoaAgentConfig


@pytest.mark.unit
class TestDefaults:
    def test_defaults_safe_for_bundled_agent(self):
        cfg = ByoaAgentConfig()
        # Heartbeat must be strictly less than server stale window / 2 so
        # one missed beat doesn't make the lock steal-eligible.
        assert (
            cfg.heartbeat_interval_seconds
            < cfg.server_lock_stale_seconds_expected / 2.0
        )
        assert cfg.max_concurrent_tasks > 0


@pytest.mark.unit
class TestFromEnv:
    def test_empty_env_returns_defaults(self):
        cfg = ByoaAgentConfig.from_env(env={})
        assert cfg == ByoaAgentConfig()

    def test_env_overrides_apply(self):
        env = {
            "BYOA_HEARTBEAT_INTERVAL_SECONDS": "45",
            "BYOA_MAX_CONCURRENT_TASKS": "8",
            "BYOA_TOOL_CALL_TIMEOUT_SECONDS": "12.5",
            "BYOA_SERVER_LOCK_STALE_SECONDS": "200",
        }
        cfg = ByoaAgentConfig.from_env(env=env)
        assert cfg.heartbeat_interval_seconds == 45
        assert cfg.max_concurrent_tasks == 8
        assert cfg.tool_call_timeout_seconds == 12.5
        assert cfg.server_lock_stale_seconds_expected == 200
        # Untouched fields keep defaults.
        assert cfg.task_request_timeout_seconds == 600.0

    def test_empty_string_env_falls_back_to_default(self):
        env = {"BYOA_HEARTBEAT_INTERVAL_SECONDS": ""}
        cfg = ByoaAgentConfig.from_env(env=env)
        assert cfg.heartbeat_interval_seconds == 60

    def test_custom_prefix(self):
        env = {"OPS_HEARTBEAT_INTERVAL_SECONDS": "90"}
        cfg = ByoaAgentConfig.from_env(env=env, prefix="OPS_")
        assert cfg.heartbeat_interval_seconds == 90


@pytest.mark.unit
class TestHeartbeatValidation:
    def test_safe_cadence_returns_none(self):
        cfg = ByoaAgentConfig(
            heartbeat_interval_seconds=60,
            server_lock_stale_seconds_expected=180,
        )
        assert cfg.validate_heartbeat_against_server() is None

    def test_too_slow_returns_warning(self):
        cfg = ByoaAgentConfig(
            heartbeat_interval_seconds=120,
            server_lock_stale_seconds_expected=180,
        )
        warning = cfg.validate_heartbeat_against_server()
        assert warning is not None
        assert "missed beat" in warning

    def test_exact_half_window_warns(self):
        # Edge: heartbeat == window/2 leaves no margin for a missed beat.
        cfg = ByoaAgentConfig(
            heartbeat_interval_seconds=90,
            server_lock_stale_seconds_expected=180,
        )
        assert cfg.validate_heartbeat_against_server() is not None
