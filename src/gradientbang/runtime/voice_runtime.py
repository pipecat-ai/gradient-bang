"""Voice LLM tool wiring for the runtime host."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

from gradientbang.runtime.tool_schema import VOICE_TOOLS


VOICE_TOOL_HANDLERS: Mapping[str, str] = MappingProxyType(
    {
        "my_status": "_handle_my_status",
        "plot_course": "_handle_plot_course",
        "list_known_ports": "_handle_list_known_ports",
        "rename_ship": "_handle_rename_ship",
        "sell_ship": "_handle_sell_ship",
        "rename_corporation": "_handle_rename_corporation",
        "create_corporation": "_handle_create_corporation",
        "join_corporation": "_handle_join_corporation",
        "leave_corporation": "_handle_leave_corporation",
        "kick_corporation_member": "_handle_kick_corporation_member",
        "confirm_action": "_handle_confirm_action",
        "regenerate_invite_code": "_handle_regenerate_invite_code",
        "send_message": "_handle_send_message",
        "combat_initiate": "_handle_combat_initiate",
        "combat_action": "_handle_combat_action",
        "ship_strategy": "_handle_ship_strategy",
        "corporation_info": "_handle_corporation_info",
        "leaderboard_resources": "_handle_leaderboard_resources",
        "ship_definitions": "_handle_ship_definitions",
        "load_game_info": "_handle_load_game_info",
        "start_task": "_handle_start_task_tool",
        "stop_task": "_handle_stop_task_tool",
        "steer_task": "_handle_steer_task_tool",
        "query_task_progress": "_handle_query_task_progress_tool",
    }
)

ToolCallable = Callable[..., Any]
ToolErrorWrapper = Callable[[str, ToolCallable], ToolCallable]
ToolCallTracker = Callable[[ToolCallable], ToolCallable]


def build_voice_tools() -> list[Any]:
    """Return the standard voice tool schemas."""
    return list(VOICE_TOOLS.standard_tools)


def bind_voice_tools(
    llm: Any,
    host: Any,
    *,
    error_wrapper: ToolErrorWrapper | None = None,
    call_tracker: ToolCallTracker | None = None,
) -> None:
    """Register voice tools on an LLM service using handlers from ``host``."""
    for schema in VOICE_TOOLS.standard_tools:
        tool_name = schema.name
        handler_name = VOICE_TOOL_HANDLERS.get(tool_name)
        if handler_name is None:
            raise KeyError(f"No voice tool handler mapping for {tool_name!r}")
        handler = getattr(host, handler_name, None)
        if handler is None:
            raise AttributeError(
                f"{type(host).__name__} is missing handler {handler_name!r} "
                f"for voice tool {tool_name!r}"
            )
        if error_wrapper is not None:
            handler = error_wrapper(tool_name, handler)
        if call_tracker is not None:
            handler = call_tracker(handler)
        llm.register_function(tool_name, handler)


@dataclass(slots=True)
class VoiceRuntime:
    """Small helper for voice LLM tools; not a Pipecat worker."""

    host: Any
    error_wrapper: ToolErrorWrapper | None = None
    call_tracker: ToolCallTracker | None = None

    def build_tools(self) -> list[Any]:
        return build_voice_tools()

    def bind_tools(self, llm: Any) -> None:
        bind_voice_tools(
            llm,
            self.host,
            error_wrapper=self.error_wrapper,
            call_tracker=self.call_tracker,
        )
