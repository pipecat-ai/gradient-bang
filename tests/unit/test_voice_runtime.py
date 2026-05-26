from unittest.mock import MagicMock

import pytest

from gradientbang.runtime.voice_runtime import (
    VOICE_TOOL_HANDLERS,
    VoiceRuntime,
    bind_voice_tools,
    build_voice_tools,
)

pytestmark = pytest.mark.unit

EXPECTED_TOOLS = {
    "my_status",
    "plot_course",
    "list_known_ports",
    "rename_ship",
    "sell_ship",
    "rename_corporation",
    "create_corporation",
    "join_corporation",
    "leave_corporation",
    "kick_corporation_member",
    "regenerate_invite_code",
    "corporation_info",
    "leaderboard_resources",
    "ship_definitions",
    "send_message",
    "combat_initiate",
    "combat_action",
    "ship_strategy",
    "load_game_info",
    "confirm_action",
    "start_task",
    "stop_task",
    "steer_task",
    "query_task_progress",
}


class _Host:
    pass


def _host_with_handlers() -> _Host:
    host = _Host()
    for handler_name in VOICE_TOOL_HANDLERS.values():
        setattr(host, handler_name, MagicMock(name=handler_name))
    return host


def test_build_voice_tools_returns_expected_schemas() -> None:
    tool_names = {tool.name for tool in build_voice_tools()}

    assert tool_names == EXPECTED_TOOLS
    assert set(VOICE_TOOL_HANDLERS) == EXPECTED_TOOLS


def test_bind_voice_tools_registers_all_handlers() -> None:
    llm = MagicMock()
    host = _host_with_handlers()

    bind_voice_tools(llm, host)

    registered = {call.args[0] for call in llm.register_function.call_args_list}
    assert registered == EXPECTED_TOOLS
    for call in llm.register_function.call_args_list:
        tool_name, handler = call.args
        assert handler is getattr(host, VOICE_TOOL_HANDLERS[tool_name])


def test_bind_voice_tools_applies_wrappers_in_old_order() -> None:
    llm = MagicMock()
    host = _host_with_handlers()
    wrapped = {}
    tracked = {}

    def error_wrapper(tool_name, handler):
        value = MagicMock(name=f"safe_{tool_name}")
        wrapped[handler] = value
        return value

    def call_tracker(handler):
        value = MagicMock(name=f"tracked_{handler._mock_name}")
        tracked[handler] = value
        return value

    bind_voice_tools(
        llm,
        host,
        error_wrapper=error_wrapper,
        call_tracker=call_tracker,
    )

    for call in llm.register_function.call_args_list:
        tool_name, handler = call.args
        original = getattr(host, VOICE_TOOL_HANDLERS[tool_name])
        assert handler is tracked[wrapped[original]]


def test_bind_voice_tools_reports_missing_host_handler() -> None:
    llm = MagicMock()

    with pytest.raises(AttributeError, match="_handle_my_status"):
        bind_voice_tools(llm, _Host())


def test_voice_runtime_delegates_to_helpers() -> None:
    llm = MagicMock()
    host = _host_with_handlers()
    runtime = VoiceRuntime(host=host)

    assert {tool.name for tool in runtime.build_tools()} == EXPECTED_TOOLS

    runtime.bind_tools(llm)

    assert llm.register_function.call_count == len(EXPECTED_TOOLS)
