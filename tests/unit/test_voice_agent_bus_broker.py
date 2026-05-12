"""Tests for VoiceAgent's Phase 1 BYOA broker.

Each test sends an inbound bus message through the broker's
``on_bus_message`` (via the typed dispatcher), mocks ``AsyncGameClient``,
and asserts:

  - the right method is invoked with tool kwargs only; per-call
    character_id / actor_character_id live in ContextVars,
  - per-call ContextVars reset after the call, even on exception,
  - the matching response message is sent back with the original
    correlation_id,
  - exceptions are translated into ``error=str(e)`` on the response,
    never re-raised.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest
from pipecat_subagents.agents.task_context import TaskStatus
from pipecat_subagents.bus.messages import BusTaskResponseMessage, BusTaskUpdateMessage

from gradientbang.pipecat_server.subagents.bus_messages import (
    BusCombatStrategyRequest,
    BusCombatStrategyResponse,
    BusCorporationQueryRequest,
    BusCorporationQueryResponse,
    BusGameToolCallRequest,
    BusGameToolCallResponse,
    BusTaskFinishNotification,
)
from gradientbang.pipecat_server.subagents.voice_agent import VoiceAgent


def _make_voice_agent() -> VoiceAgent:
    mock_game_client = MagicMock()
    mock_game_client.corporation_id = "corp-1"
    mock_game_client.current_task_id = None
    mock_game_client.set_event_polling_scope = MagicMock()
    mock_game_client.task_lifecycle = AsyncMock(return_value={"success": True})
    mock_game_client.task_cancel = AsyncMock(return_value={"success": True})
    mock_game_client.task_heartbeat = AsyncMock(return_value={"refreshed": 0})

    mock_rtvi = MagicMock()
    mock_rtvi.push_frame = AsyncMock()

    agent = VoiceAgent(
        "player",
        bus=MagicMock(),
        game_client=mock_game_client,
        character_id="char-123",
        rtvi_processor=mock_rtvi,
    )
    agent.send_message = AsyncMock()
    return agent


def _last_sent_message(agent: VoiceAgent):
    assert agent.send_message.await_count >= 1
    return agent.send_message.await_args_list[-1].args[0]


# ── Tool-call broker ──────────────────────────────────────────────────


@pytest.mark.unit
class TestGameToolCallBroker:
    @pytest.mark.asyncio
    async def test_dispatches_method_with_overridden_identity(self):
        agent = _make_voice_agent()
        agent._game_client.move = AsyncMock(return_value={"new_sector": 5})

        msg = BusGameToolCallRequest(
            source="task_abc",
            target="player",
            correlation_id="r1",
            tool_name="move",
            args={"to_sector": 5},
            character_id="corp-ship-abc",
            actor_character_id="char-123",
            task_id="task-uuid",
        )
        await agent.on_bus_message(msg)

        # Method called with tool args only; broker identity is carried by
        # ContextVars and applied later by Supabase payload injection.
        agent._game_client.move.assert_awaited_once_with(to_sector=5)
        # Response carries result + correlation_id.
        sent = _last_sent_message(agent)
        assert isinstance(sent, BusGameToolCallResponse)
        assert sent.correlation_id == "r1"
        assert sent.result == {"new_sector": 5}
        assert sent.error is None
        assert sent.target == "task_abc"

    @pytest.mark.asyncio
    async def test_task_id_propagated_via_per_call_contextvar(self):
        """The broker propagates task_id via a ContextVar instead of
        mutating the shared client's current_task_id. The ContextVar is
        per-asyncio-Task, so two concurrent brokered RPCs can never
        cross-tag each other's events.
        """
        from gradientbang.utils.supabase_client import _per_call_task_id

        agent = _make_voice_agent()
        captured: list = []

        async def move_check(**_kwargs):
            # Read the ContextVar from inside the awaited method body —
            # this is the value _inject_character_ids would see when
            # building the outbound payload.
            captured.append(_per_call_task_id.get())
            return {"ok": True}

        agent._game_client.move = AsyncMock(side_effect=move_check)
        agent._game_client.current_task_id = "should-not-leak"

        msg = BusGameToolCallRequest(
            source="task_abc",
            correlation_id="r1",
            tool_name="move",
            args={},
            character_id="char-x",
            task_id="active-task",
        )
        await agent.on_bus_message(msg)

        assert captured == ["active-task"]
        # Outside the with-block, the ContextVar resets to its default.
        assert _per_call_task_id.get() is None
        # And the shared client field is no longer mutated by the broker.
        assert agent._game_client.current_task_id == "should-not-leak"

    @pytest.mark.asyncio
    async def test_identity_propagated_via_per_call_contextvars(self):
        from gradientbang.utils.supabase_client import (
            _per_call_actor_character_id,
            _per_call_character_id,
        )

        agent = _make_voice_agent()
        captured: list[tuple[str | None, str | None]] = []

        async def get_ship_definitions_check(**_kwargs):
            captured.append(
                (
                    _per_call_character_id.get(),
                    _per_call_actor_character_id.get(),
                )
            )
            return {"definitions": []}

        agent._game_client.get_ship_definitions = AsyncMock(
            side_effect=get_ship_definitions_check
        )

        msg = BusGameToolCallRequest(
            source="task_abc",
            correlation_id="r1",
            tool_name="get_ship_definitions",
            args={},
            character_id="corp-ship-abc",
            actor_character_id="char-123",
        )
        await agent.on_bus_message(msg)

        agent._game_client.get_ship_definitions.assert_awaited_once_with()
        assert captured == [("corp-ship-abc", "char-123")]
        assert _per_call_character_id.get() is None
        assert _per_call_actor_character_id.get() is None

    @pytest.mark.asyncio
    async def test_task_id_contextvar_resets_on_exception(self):
        from gradientbang.utils.supabase_client import (
            _per_call_actor_character_id,
            _per_call_character_id,
            _per_call_task_id,
        )

        agent = _make_voice_agent()
        agent._game_client.move = AsyncMock(side_effect=RuntimeError("boom"))
        agent._game_client.current_task_id = "should-not-leak"

        msg = BusGameToolCallRequest(
            source="task_abc",
            correlation_id="r1",
            tool_name="move",
            args={},
            character_id="char-x",
            task_id="active-task",
        )
        await agent.on_bus_message(msg)

        # Even on exception the contextmanager resets the ContextVar.
        assert _per_call_task_id.get() is None
        assert _per_call_character_id.get() is None
        assert _per_call_actor_character_id.get() is None
        assert agent._game_client.current_task_id == "should-not-leak"
        sent = _last_sent_message(agent)
        assert isinstance(sent, BusGameToolCallResponse)
        assert sent.result is None
        assert sent.error == "boom"

    @pytest.mark.asyncio
    async def test_envelope_identity_wins_over_args(self):
        """Envelope ``character_id`` / ``actor_character_id`` are
        authoritative — a sender can't spoof identity by stuffing those
        fields into ``args``. The broker strips identity args and carries
        the envelope identity through ContextVars.
        """
        from gradientbang.utils.supabase_client import (
            _per_call_actor_character_id,
            _per_call_character_id,
        )

        agent = _make_voice_agent()
        captured: list[tuple[str | None, str | None]] = []

        async def move_check(**_kwargs):
            captured.append(
                (
                    _per_call_character_id.get(),
                    _per_call_actor_character_id.get(),
                )
            )
            return {"ok": True}

        agent._game_client.move = AsyncMock(side_effect=move_check)

        msg = BusGameToolCallRequest(
            source="task_abc",
            correlation_id="r1",
            tool_name="move",
            args={
                "to_sector": 5,
                # Malicious / malformed args trying to shadow envelope identity.
                "character_id": "spoofed-char",
                "actor_character_id": "spoofed-actor",
            },
            character_id="real-char",
            actor_character_id="real-actor",
        )
        await agent.on_bus_message(msg)

        agent._game_client.move.assert_awaited_once_with(to_sector=5)
        assert captured == [("real-char", "real-actor")]

    @pytest.mark.asyncio
    async def test_required_character_id_methods_receive_bound_client_id(self):
        """Legacy client methods such as ``my_status`` still require a local
        ``character_id`` kwarg and validate it against the bound voice client.
        The broker supplies that local id only; the corp-ship envelope id is
        applied later at payload injection.
        """
        agent = _make_voice_agent()
        captured: list[str] = []

        async def my_status_check(character_id: str):
            captured.append(character_id)
            return {"ok": True}

        agent._game_client.my_status = my_status_check

        msg = BusGameToolCallRequest(
            source="task_abc",
            correlation_id="r1",
            tool_name="my_status",
            args={},
            character_id="corp-ship-abc",
            actor_character_id="char-123",
        )
        await agent.on_bus_message(msg)

        assert captured == ["char-123"]
        sent = _last_sent_message(agent)
        assert isinstance(sent, BusGameToolCallResponse)
        assert sent.error is None

    @pytest.mark.asyncio
    async def test_unknown_tool_returns_error(self):
        agent = _make_voice_agent()
        # MagicMock auto-creates every attribute and looks callable, which
        # would mask a "missing method" bug in the broker. spec the client
        # so only explicitly-allowed attrs are reachable; the broker's
        # getattr(..., None) fallback then trips correctly. _game_client
        # is a read-only property — assign the name-mangled private.
        spec_client = MagicMock(
            spec=["task_lifecycle", "task_cancel", "task_heartbeat", "current_task_id"]
        )
        spec_client.current_task_id = None
        agent._VoiceAgent__game_client = spec_client

        msg = BusGameToolCallRequest(
            source="task_abc",
            correlation_id="r1",
            tool_name="not_a_real_method",
            args={},
            character_id="char-x",
        )
        await agent.on_bus_message(msg)
        sent = _last_sent_message(agent)
        assert isinstance(sent, BusGameToolCallResponse)
        assert sent.result is None
        assert "unknown tool" in sent.error
        assert "not_a_real_method" in sent.error

    @pytest.mark.asyncio
    async def test_byoa_source_requires_active_task(self):
        agent = _make_voice_agent()
        agent._game_client.get_ship_definitions = AsyncMock(return_value={"definitions": []})

        msg = BusGameToolCallRequest(
            source="byoa_ship-123",
            target="player",
            correlation_id="r-byoa",
            tool_name="get_ship_definitions",
            args={},
            character_id="spoofed-ship",
            actor_character_id="spoofed-actor",
            task_id="task-1",
        )
        await agent.on_bus_message(msg)

        agent._game_client.get_ship_definitions.assert_not_awaited()
        sent = _last_sent_message(agent)
        assert isinstance(sent, BusGameToolCallResponse)
        assert sent.result is None
        assert sent.error == "unauthorized_byoa_source"

    @pytest.mark.asyncio
    async def test_byoa_runner_source_cannot_broker_tools(self):
        agent = _make_voice_agent()
        agent._game_client.get_ship_definitions = AsyncMock(return_value={"definitions": []})

        msg = BusGameToolCallRequest(
            source="byoa_runner_ship-123",
            target="player",
            correlation_id="r-byoa-runner",
            tool_name="get_ship_definitions",
            args={},
            character_id="spoofed-ship",
            actor_character_id="spoofed-actor",
            task_id="task-1",
        )
        await agent.on_bus_message(msg)

        agent._game_client.get_ship_definitions.assert_not_awaited()
        sent = _last_sent_message(agent)
        assert isinstance(sent, BusGameToolCallResponse)
        assert sent.error == "unauthorized_byoa_source"

    @pytest.mark.asyncio
    async def test_byoa_active_task_identity_comes_from_broker_state(self):
        from gradientbang.utils.supabase_client import (
            _per_call_actor_character_id,
            _per_call_character_id,
            _per_call_task_id,
        )

        agent = _make_voice_agent()
        agent._byoa_active_agents["byoa_ship-123"] = {
            "task_id": "task-real",
            "character_id": "ship-real",
            "actor_character_id": "actor-real",
            "task_metadata": {"ship_name": "Auditor"},
        }
        captured: list[tuple[str | None, str | None, str | None]] = []

        async def get_defs_check(**_kwargs):
            captured.append(
                (
                    _per_call_character_id.get(),
                    _per_call_actor_character_id.get(),
                    _per_call_task_id.get(),
                )
            )
            return {"definitions": []}

        agent._game_client.get_ship_definitions = AsyncMock(side_effect=get_defs_check)

        msg = BusGameToolCallRequest(
            source="byoa_ship-123",
            target="player",
            correlation_id="r-byoa",
            tool_name="get_ship_definitions",
            args={
                "character_id": "spoofed-ship",
                "actor_character_id": "spoofed-actor",
            },
            character_id="spoofed-envelope-ship",
            actor_character_id="spoofed-envelope-actor",
            task_id="task-real",
        )
        await agent.on_bus_message(msg)

        agent._game_client.get_ship_definitions.assert_awaited_once_with()
        assert captured == [("ship-real", "actor-real", "task-real")]
        sent = _last_sent_message(agent)
        assert isinstance(sent, BusGameToolCallResponse)
        assert sent.error is None

    @pytest.mark.asyncio
    async def test_byoa_wrong_task_id_rejected(self):
        agent = _make_voice_agent()
        agent._byoa_active_agents["byoa_ship-123"] = {
            "task_id": "task-real",
            "character_id": "ship-real",
            "actor_character_id": "actor-real",
            "task_metadata": {},
        }
        agent._game_client.get_ship_definitions = AsyncMock(return_value={"definitions": []})

        msg = BusGameToolCallRequest(
            source="byoa_ship-123",
            target="player",
            correlation_id="r-byoa",
            tool_name="get_ship_definitions",
            args={},
            character_id="ship-real",
            actor_character_id="actor-real",
            task_id="task-other",
        )
        await agent.on_bus_message(msg)

        agent._game_client.get_ship_definitions.assert_not_awaited()
        sent = _last_sent_message(agent)
        assert isinstance(sent, BusGameToolCallResponse)
        assert sent.error == "unauthorized_byoa_task"


# ── BYOA task lifecycle authorization ─────────────────────────────────


@pytest.mark.unit
class TestByoaTaskLifecycleAuthorization:
    @pytest.mark.asyncio
    async def test_byoa_task_response_wrong_task_id_is_ignored(self):
        agent = _make_voice_agent()
        agent._byoa_active_agents["byoa_ship-123"] = {
            "task_id": "task-real",
            "character_id": "ship-real",
            "actor_character_id": "actor-real",
            "task_metadata": {},
        }
        agent._locked_ships["ship-real"] = "task-real"
        agent._task_output_handler = AsyncMock()
        agent._enqueue_deferred_update = MagicMock()
        agent._update_polling_scope = MagicMock()

        msg = BusTaskResponseMessage(
            source="byoa_ship-123",
            target="player",
            task_id="task-other",
            status=TaskStatus.COMPLETED,
            response={"message": "spoofed completion"},
        )
        await agent.on_task_response(msg)

        agent._task_output_handler.assert_not_awaited()
        agent._enqueue_deferred_update.assert_not_called()
        assert agent._locked_ships["ship-real"] == "task-real"
        assert "byoa_ship-123" in agent._byoa_active_agents

    @pytest.mark.asyncio
    async def test_byoa_task_update_wrong_task_id_is_ignored(self):
        agent = _make_voice_agent()
        agent._byoa_active_agents["byoa_ship-123"] = {
            "task_id": "task-real",
            "character_id": "ship-real",
            "actor_character_id": "actor-real",
            "task_metadata": {},
        }
        agent._task_output_handler = AsyncMock()

        msg = BusTaskUpdateMessage(
            source="byoa_ship-123",
            target="player",
            task_id="task-other",
            update={"type": "output", "text": "spoofed progress"},
        )
        await agent.on_task_update(msg)

        agent._task_output_handler.assert_not_awaited()


# ── Combat-strategy broker ────────────────────────────────────────────


@pytest.mark.unit
class TestCombatStrategyBroker:
    @pytest.mark.asyncio
    async def test_dispatches_combat_get_strategy(self):
        agent = _make_voice_agent()
        agent._game_client.combat_get_strategy = AsyncMock(
            return_value={"doctrine": "aggressive"}
        )

        msg = BusCombatStrategyRequest(
            source="task_abc",
            correlation_id="r2",
            character_id="corp-ship-abc",
        )
        await agent.on_bus_message(msg)

        agent._game_client.combat_get_strategy.assert_awaited_once_with(
            character_id="corp-ship-abc"
        )
        sent = _last_sent_message(agent)
        assert isinstance(sent, BusCombatStrategyResponse)
        assert sent.correlation_id == "r2"
        assert sent.strategy == {"doctrine": "aggressive"}
        assert sent.error is None

    @pytest.mark.asyncio
    async def test_exception_translated_to_error(self):
        agent = _make_voice_agent()
        agent._game_client.combat_get_strategy = AsyncMock(
            side_effect=RuntimeError("no strategy configured")
        )

        msg = BusCombatStrategyRequest(
            source="task_abc",
            correlation_id="r2",
            character_id="corp-ship-abc",
        )
        await agent.on_bus_message(msg)

        sent = _last_sent_message(agent)
        assert isinstance(sent, BusCombatStrategyResponse)
        assert sent.strategy is None
        assert sent.error == "no strategy configured"


# ── Corp-query broker ─────────────────────────────────────────────────


@pytest.mark.unit
class TestCorporationQueryBroker:
    @pytest.mark.asyncio
    async def test_my_query_routes_to_my_corporation(self):
        agent = _make_voice_agent()
        agent._game_client._request = AsyncMock(return_value={"corp_id": "corp-1"})

        msg = BusCorporationQueryRequest(
            source="task_abc",
            correlation_id="r3",
            query_type="my",
            character_id="char-123",
        )
        await agent.on_bus_message(msg)

        agent._game_client._request.assert_awaited_once_with(
            "my_corporation", {"character_id": "char-123"}
        )
        sent = _last_sent_message(agent)
        assert isinstance(sent, BusCorporationQueryResponse)
        assert sent.result == {"corp_id": "corp-1"}

    @pytest.mark.asyncio
    async def test_list_query_routes_to_corporation_list(self):
        agent = _make_voice_agent()
        agent._game_client._request = AsyncMock(
            return_value={"corporations": []}
        )

        msg = BusCorporationQueryRequest(
            source="task_abc",
            correlation_id="r3",
            query_type="list",
            character_id="char-123",
        )
        await agent.on_bus_message(msg)

        agent._game_client._request.assert_awaited_once_with(
            "corporation.list", {}
        )

    @pytest.mark.asyncio
    async def test_info_query_requires_corp_id(self):
        agent = _make_voice_agent()
        agent._game_client._request = AsyncMock()

        msg = BusCorporationQueryRequest(
            source="task_abc",
            correlation_id="r3",
            query_type="info",
            character_id="char-123",
            corp_id=None,
        )
        await agent.on_bus_message(msg)

        agent._game_client._request.assert_not_awaited()
        sent = _last_sent_message(agent)
        assert isinstance(sent, BusCorporationQueryResponse)
        assert sent.error is not None
        assert "corp_id required" in sent.error

    @pytest.mark.asyncio
    async def test_info_query_routes_to_corporation_info(self):
        agent = _make_voice_agent()
        agent._game_client._request = AsyncMock(
            return_value={"corp_id": "corp-2", "members": []}
        )

        msg = BusCorporationQueryRequest(
            source="task_abc",
            correlation_id="r3",
            query_type="info",
            character_id="char-123",
            corp_id="corp-2",
        )
        await agent.on_bus_message(msg)

        agent._game_client._request.assert_awaited_once_with(
            "corporation.info",
            {"character_id": "char-123", "corp_id": "corp-2"},
        )


# ── Task-finish broker ────────────────────────────────────────────────


@pytest.mark.unit
class TestTaskFinishBroker:
    @pytest.mark.asyncio
    async def test_dispatches_task_lifecycle_finish(self):
        agent = _make_voice_agent()
        msg = BusTaskFinishNotification(
            source="task_abc",
            character_id="corp-ship-abc",
            actor_character_id="player-123",
            task_id="task-uuid",
            status="completed",
            summary="reached sector 5",
        )
        await agent.on_bus_message(msg)

        # task_metadata carries the actor so it lands as actor_character_id
        # on the outbound payload — the server's BYOA-private finish check
        # is keyed on this field, not on character_id (the pseudo-char).
        agent._game_client.task_lifecycle.assert_awaited_once_with(
            character_id="corp-ship-abc",
            task_id="task-uuid",
            event_type="finish",
            task_status="completed",
            task_summary="reached sector 5",
            task_metadata={"actor_character_id": "player-123"},
        )

    @pytest.mark.asyncio
    async def test_finish_without_actor_omits_metadata(self):
        """Player-ship tasks don't have a distinct actor — finish carries
        no actor_character_id, broker passes task_metadata=None."""
        agent = _make_voice_agent()
        msg = BusTaskFinishNotification(
            source="task_abc",
            character_id="char-123",
            actor_character_id="",  # default
            task_id="task-uuid",
            status="completed",
        )
        await agent.on_bus_message(msg)
        agent._game_client.task_lifecycle.assert_awaited_once_with(
            character_id="char-123",
            task_id="task-uuid",
            event_type="finish",
            task_status="completed",
            task_summary=None,
            task_metadata=None,
        )

    @pytest.mark.asyncio
    async def test_no_response_message_sent(self):
        """task.finish is fire-and-forget — no Response* message."""
        agent = _make_voice_agent()
        msg = BusTaskFinishNotification(
            source="task_abc",
            character_id="char-x",
            task_id="task-uuid",
            status="completed",
        )
        await agent.on_bus_message(msg)
        for call in agent.send_message.await_args_list:
            if call.args:
                # No Response/Notification sent back for finish.
                assert not isinstance(call.args[0], BusTaskFinishNotification)

    @pytest.mark.asyncio
    async def test_failure_is_logged_not_raised(self):
        agent = _make_voice_agent()
        agent._game_client.task_lifecycle = AsyncMock(
            side_effect=RuntimeError("network down")
        )
        msg = BusTaskFinishNotification(
            source="task_abc",
            character_id="char-x",
            task_id="task-uuid",
            status="completed",
        )
        # Must not raise — broker logs and moves on.
        await agent.on_bus_message(msg)
