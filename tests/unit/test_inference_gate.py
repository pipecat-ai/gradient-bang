"""Tests for InferenceGate — combat_pov gating and reason priority."""

import pytest

from pipecat.frames.frames import LLMMessagesAppendFrame

from gradientbang.pipecat_server.inference_gate import (
    InferenceGateState,
    PreLLMInferenceGate,
)


def _frame(content: str) -> LLMMessagesAppendFrame:
    return LLMMessagesAppendFrame(
        messages=[{"role": "user", "content": content}], run_llm=True
    )


@pytest.mark.unit
class TestInferenceReasonForEvent:
    """Direct combat events are 'combat_event' priority and bypass cooldown.
    Observed combat downgrades to 'event' so it cannot interrupt the bot."""

    def test_direct_combat_round_waiting_is_combat_event(self):
        frame = _frame(
            '<event name="combat.round_waiting" combat_id="cbt-1" combat_pov="direct">\n'
            "...\n</event>"
        )
        reason = PreLLMInferenceGate._inference_reason_for_event(frame, "combat.round_waiting")
        assert reason == "combat_event"

    def test_observed_corp_ship_downgrades_to_event(self):
        frame = _frame(
            '<event name="combat.round_waiting" combat_id="cbt-1" '
            'combat_pov="observed_via_corp_ship" ship_id="ship-probe">\n'
            "...\n</event>"
        )
        reason = PreLLMInferenceGate._inference_reason_for_event(frame, "combat.round_waiting")
        assert reason == "event"

    def test_observed_garrison_downgrades_to_event(self):
        frame = _frame(
            '<event name="combat.round_waiting" combat_id="cbt-1" '
            'combat_pov="observed_via_garrison" garrison_id="garrison:42:char-1">\n'
            "...\n</event>"
        )
        reason = PreLLMInferenceGate._inference_reason_for_event(frame, "combat.round_waiting")
        assert reason == "event"

    def test_sector_only_downgrades_to_event(self):
        frame = _frame(
            '<event name="combat.round_waiting" combat_id="cbt-1" '
            'combat_pov="observed_sector_only">\n...\n</event>'
        )
        reason = PreLLMInferenceGate._inference_reason_for_event(frame, "combat.round_waiting")
        assert reason == "event"

    def test_missing_combat_pov_falls_back_to_combat_event(self):
        # Backwards compat: pre-attr combat events keep the old priority.
        frame = _frame(
            '<event name="combat.round_waiting" combat_id="cbt-1">\n...\n</event>'
        )
        reason = PreLLMInferenceGate._inference_reason_for_event(frame, "combat.round_waiting")
        assert reason == "combat_event"

    def test_non_combat_event_is_event_priority(self):
        frame = _frame('<event name="chat.message">\nhi\n</event>')
        reason = PreLLMInferenceGate._inference_reason_for_event(frame, "chat.message")
        assert reason == "event"


@pytest.mark.unit
class TestReasonPriority:
    """combat_event outranks event so a direct-combat trigger pre-empts a
    pending observed-combat trigger when both are queued."""

    def test_combat_event_outranks_event(self):
        assert (
            InferenceGateState._reason_priority("combat_event")
            > InferenceGateState._reason_priority("event")
        )

    def test_event_outranks_tool_result(self):
        assert (
            InferenceGateState._reason_priority("event")
            > InferenceGateState._reason_priority("tool_result")
        )
