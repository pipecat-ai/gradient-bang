"""Tests for the BYOA harness hook surface."""

from __future__ import annotations

import pytest

from gradientbang.runtime.byoa import ByoaAgentConfig, ByoaApp, ByoaCombatWake, ByoaContext
from gradientbang.runtime.byoa.app import _hooks_summary


def _ctx() -> ByoaContext:
    return ByoaContext(
        ship_id="ship-1",
        character_id="char-1",
        channel="channel-1",
        bus_dsn="postgresql://example",
        prompt=None,
        config=ByoaAgentConfig(),
        task_id="task-1",
        wake_request_id=None,
    )


@pytest.mark.unit
class TestCombatWakeHook:
    async def test_returns_replacement_wake(self):
        app = ByoaApp()

        @app.on_combat_wake
        def combat_policy(ctx: ByoaContext, wake: ByoaCombatWake) -> ByoaCombatWake:
            assert ctx.ship_id == "ship-1"
            return ByoaCombatWake(
                goal=f"{wake.goal}\nPrefer flee.",
                context=f"{wake.context}\nmode: defensive",
            )

        result = await app._apply_combat_wake(_ctx(), "Fight now.", "combat_id: cbt-1")

        assert result.goal == "Fight now.\nPrefer flee."
        assert result.context == "combat_id: cbt-1\nmode: defensive"

    async def test_none_keeps_default_wake(self):
        app = ByoaApp()

        @app.on_combat_wake
        def observe_only(_ctx: ByoaContext, _wake: ByoaCombatWake) -> None:
            return None

        result = await app._apply_combat_wake(_ctx(), "Fight now.", "combat_id: cbt-1")

        assert result == ByoaCombatWake(goal="Fight now.", context="combat_id: cbt-1")

    async def test_hook_error_keeps_default_wake(self):
        app = ByoaApp()

        @app.on_combat_wake
        def broken(_ctx: ByoaContext, _wake: ByoaCombatWake) -> ByoaCombatWake:
            raise RuntimeError("boom")

        result = await app._apply_combat_wake(_ctx(), "Fight now.", "combat_id: cbt-1")

        assert result == ByoaCombatWake(goal="Fight now.", context="combat_id: cbt-1")

    async def test_invalid_return_type_keeps_default_wake(self):
        app = ByoaApp()

        @app.on_combat_wake
        def broken(_ctx: ByoaContext, _wake: ByoaCombatWake) -> object:
            return "fight differently"

        result = await app._apply_combat_wake(_ctx(), "Fight now.", "combat_id: cbt-1")

        assert result == ByoaCombatWake(goal="Fight now.", context="combat_id: cbt-1")

    def test_hooks_summary_includes_combat_wake(self):
        app = ByoaApp()

        @app.on_combat_wake
        def combat_policy(_ctx: ByoaContext, _wake: ByoaCombatWake) -> None:
            return None

        assert "on_combat_wake" in _hooks_summary(app)
