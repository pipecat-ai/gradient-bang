"""Session bootstrap.

Owns the bot's startup data-gathering flow: the explicit RPCs that build
the VoiceAgent's initial LLM context. Runs as a strict sequence after the
client connects, before the agent activates. Failures bubble up — the
bot bails rather than half-joining.

Contract with the rest of the bot:
- ``gather_initial_state`` returns an :class:`InitialState` with everything
  bot.py needs to seed the LLM context (substitutions, formatted user
  messages, the onboarding trigger), and is the only place these RPC
  responses get consumed for context purposes.
- EventRelay's job stays the steady-state event stream; it does not
  participate in bootstrap.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional

from loguru import logger

from gradientbang.utils.prompt_loader import load_prompt
from gradientbang.utils.supabase_client import AsyncGameClient


@dataclass
class InitialState:
    """Everything bot.py needs to seed the VoiceAgent's first inference."""

    is_first_visit: bool
    is_new_player: bool
    universe_size: Optional[int]
    fedspace_sector_count: Optional[int]
    initial_messages: List[dict]
    onboarding_route: Optional[List[int]]
    session_started_at: str
    display_name: str
    status_payload: Dict[str, Any]
    ships_payload: Dict[str, Any]
    map_local_payload: Dict[str, Any]
    quest_payload: Dict[str, Any]


def _wrap_event_xml(event_name: str, summary: str) -> str:
    return f'<event name="{event_name}">\n{summary}\n</event>'


def _extract_universe_info(status_payload: Any) -> tuple[Optional[int], Optional[int]]:
    if not isinstance(status_payload, Mapping):
        return None, None
    player = status_payload.get("player")
    if not isinstance(player, Mapping):
        return None, None
    universe = player.get("universe_size")
    fedspace = player.get("fedspace_sector_count")
    return (
        universe if isinstance(universe, int) else None,
        fedspace if isinstance(fedspace, int) else None,
    )


def _extract_display_name(status_payload: Any, fallback: str) -> str:
    if isinstance(status_payload, Mapping):
        player = status_payload.get("player")
        if isinstance(player, Mapping):
            name = player.get("name")
            if isinstance(name, str) and name.strip():
                return name.strip()
    return fallback


def _is_new_player(ports_payload: Any) -> bool:
    """A player is 'new' if they have no known mega-ports yet."""
    if not isinstance(ports_payload, Mapping):
        return False
    ports = ports_payload.get("ports")
    return isinstance(ports, list) and len(ports) == 0


def _build_onboarding_xml(
    display_name: str, onboarding_route: Optional[List[int]]
) -> str:
    if onboarding_route and len(onboarding_route) > 1:
        route_str = " → ".join(str(s) for s in onboarding_route)
    else:
        route_str = "unavailable"
    content = load_prompt("fragments/onboarding.md").format(
        display_name=display_name,
        route_to_megaport=route_str,
    )
    return f'<event name="onboarding">\n{content}</event>'


async def gather_initial_state(
    *,
    game_client: AsyncGameClient,
    character_id: str,
    character_display_name: str,
) -> InitialState:
    """Fetch initial state via blocking RPCs and assemble user messages
    for the LLM context.

    Each RPC returns its result inline (the matching events still emit
    for any other subscribers — UI, BYOAs — via the event channel).
    Failures raise; the caller is expected to bail the session.
    """
    session_started_at = datetime.now(timezone.utc).isoformat()

    join_result = await game_client.join(character_id)
    if not isinstance(join_result, Mapping):
        raise RuntimeError(f"join returned non-mapping result: {type(join_result)}")
    is_first_visit = bool(join_result.get("is_first_visit", False))
    status_payload = join_result.get("status") or {}
    map_local_payload = join_result.get("map_local") or {}
    onboarding_route_raw = join_result.get("onboarding_route")
    onboarding_route: Optional[List[int]] = None
    if isinstance(onboarding_route_raw, list) and len(onboarding_route_raw) > 1:
        try:
            onboarding_route = [int(s) for s in onboarding_route_raw]
        except (TypeError, ValueError):
            onboarding_route = None

    display_name = _extract_display_name(status_payload, character_display_name)
    universe_size, fedspace_sector_count = _extract_universe_info(status_payload)

    ships_result = await game_client.list_user_ships(character_id=character_id)
    quest_result = await game_client.quest_status(character_id=character_id)
    ports_result = await game_client.list_known_ports(
        character_id=character_id, mega=True, max_hops=100
    )

    is_new_player = _is_new_player(ports_result)

    initial_messages: List[dict] = [
        {
            "role": "user",
            "content": f"<start_of_session>Character Name: {display_name}</start_of_session>",
        }
    ]

    for event_name, payload in (
        ("ships.list", ships_result),
        ("status.snapshot", status_payload),
        ("map.local", map_local_payload),
        ("quest.status", quest_result),
    ):
        summary = game_client._get_summary(event_name, payload)
        if summary:
            initial_messages.append(
                {"role": "user", "content": _wrap_event_xml(event_name, summary)}
            )
        else:
            logger.warning(f"session_init: no summary produced for {event_name}")

    if is_new_player:
        initial_messages.append(
            {"role": "user", "content": _build_onboarding_xml(display_name, onboarding_route)}
        )
    else:
        initial_messages.append(
            {"role": "user", "content": '<event name="session.start"></event>'}
        )

    logger.info(
        f"session_init: gathered initial state for {display_name} "
        f"(is_first_visit={is_first_visit}, is_new_player={is_new_player}, "
        f"messages={len(initial_messages)})"
    )

    return InitialState(
        is_first_visit=is_first_visit,
        is_new_player=is_new_player,
        universe_size=universe_size,
        fedspace_sector_count=fedspace_sector_count,
        initial_messages=initial_messages,
        onboarding_route=onboarding_route,
        session_started_at=session_started_at,
        display_name=display_name,
        status_payload=status_payload if isinstance(status_payload, dict) else {},
        ships_payload=ships_result if isinstance(ships_result, dict) else {},
        map_local_payload=map_local_payload if isinstance(map_local_payload, dict) else {},
        quest_payload=quest_result if isinstance(quest_result, dict) else {},
    )
