"""Single-turn SMS/WhatsApp agent POC.

This module intentionally avoids the Pipecat voice session stack. Each call to
``run_turn`` builds a fresh context, fetches current status inline, and runs one
out-of-band LLM inference.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Optional

from loguru import logger
from pipecat.processors.aggregators.llm_context import LLMContext

from gradientbang.pipecat_server.voices import DEFAULT_PERSONALITY_TONE
from gradientbang.sms_agent.env import load_sms_env
from gradientbang.utils.llm_factory import create_llm_service, get_sms_agent_llm_config
from gradientbang.utils.formatting import summarize_corporation_info
from gradientbang.utils.prompt_loader import build_sms_agent_prompt, set_prompt_substitutions
from gradientbang.utils.summary_formatters import join_summary, ships_list_summary
from gradientbang.utils.supabase_client import AsyncGameClient

load_sms_env()

SMS_TOOL_STATUS = "status"
SMS_TOOL_SHIPS = "ships"
SMS_TOOL_CORPORATION = "corporation_info"
SMS_TOOL_MAP = "map"
DEFAULT_MAP_PLACEHOLDER_IMAGE_URL = "https://placehold.co/1024x768/png?text=Gradient+Bang+Map"
SUPPORTED_TOOLS = {SMS_TOOL_STATUS, SMS_TOOL_SHIPS, SMS_TOOL_CORPORATION, SMS_TOOL_MAP}
SUPPORTED_STATUS_HINTS = {
    "status",
    "sitrep",
    "report",
    "where",
    "location",
    "sector",
    "ship",
    "warp",
    "shields",
    "fighters",
    "credits",
    "cargo",
    "port",
}
SUPPORTED_SHIPS_HINTS = {
    "ships",
    "fleet",
    "vessels",
}
SUPPORTED_CORPORATION_HINTS = {
    "corp",
    "corporation",
    "member",
    "members",
    "invite",
    "founder",
}
SUPPORTED_MAP_HINTS = {
    "map",
    "chart",
    "starchart",
    "star-chart",
    "star",
    "sector-map",
    "cartography",
}
STATUS_REQUEST_WORDS = {
    "status",
    "check status",
    "my status",
    "ship status",
    "report status",
    "status report",
    "sitrep",
    "situation report",
    "where am i",
    "where are we",
    "what is my status",
    "what's my status",
    "how am i doing",
    "how are we doing",
    "report",
}
GREETING_WORDS = {
    "hi",
    "hello",
    "hey",
    "hiya",
    "yo",
    "start",
}
IDENTITY_REQUESTS = {
    "who am i",
    "who am i?",
    "whoami",
    "what is my name",
    "what's my name",
    "my name",
    "identify me",
}


@dataclass
class StatusToolResult:
    tool_name: str
    payload: dict[str, Any]
    summary: str


@dataclass(frozen=True)
class CharacterContext:
    character_id: str
    name: Optional[str] = None
    created_at: Optional[str] = None


@dataclass(frozen=True)
class SmsTurnResponse:
    text: str
    media_url: Optional[str] = None


_CHARACTER_CONTEXT_CACHE: dict[str, CharacterContext] = {}
_GREETED_CHARACTER_IDS: set[str] = set()


def has_greeted_character(character_id: str) -> bool:
    return character_id in _GREETED_CHARACTER_IDS


def mark_character_greeted(character_id: str) -> None:
    _GREETED_CHARACTER_IDS.add(character_id)


async def fetch_character_context(
    *,
    character_id: str,
    access_token: Optional[str] = None,
) -> CharacterContext:
    """Look up and cache character identity for SMS prompt context."""
    cached = _CHARACTER_CONTEXT_CACHE.get(character_id)
    if cached:
        return cached

    try:
        async with AsyncGameClient(
            character_id=character_id,
            access_token=access_token,
            enable_event_polling=False,
        ) as game_client:
            result = await game_client.character_info(character_id=character_id)
    except Exception:  # noqa: BLE001
        logger.exception("sms_agent.character_info lookup failed character_id={}", character_id)
        return CharacterContext(character_id=character_id)

    context = CharacterContext(
        character_id=str(result.get("character_id") or character_id),
        name=result.get("name") if isinstance(result.get("name"), str) else None,
        created_at=result.get("created_at") if isinstance(result.get("created_at"), str) else None,
    )
    _CHARACTER_CONTEXT_CACHE[character_id] = context
    return context


async def fetch_tool_result(
    *,
    tool_name: str,
    character_id: str,
    access_token: Optional[str] = None,
) -> StatusToolResult:
    """Call a synchronous SMS tool endpoint and format its response."""
    if tool_name not in SUPPORTED_TOOLS:
        raise ValueError(f"Unsupported SMS tool: {tool_name}")

    if tool_name == SMS_TOOL_MAP:
        image_url = os.getenv("SMS_AGENT_MAP_PLACEHOLDER_IMAGE_URL")
        if not image_url:
            image_url = DEFAULT_MAP_PLACEHOLDER_IMAGE_URL
        return StatusToolResult(
            tool_name=tool_name,
            payload={
                "placeholder": True,
                "image_url": image_url,
            },
            summary=(
                "Placeholder star chart is attached. This is a test image only, "
                "not live navigational telemetry."
            ),
        )

    async with AsyncGameClient(
        character_id=character_id,
        access_token=access_token,
        enable_event_polling=False,
    ) as game_client:
        if tool_name == SMS_TOOL_STATUS:
            result = await game_client._request(
                "sms_agent_tools",
                {
                    "character_id": character_id,
                    "tool": "status",
                },
            )
            payload = result.get("status")
            if not isinstance(payload, dict):
                raise RuntimeError("sms_agent_tools returned no status payload")

            summary = result.get("summary")
            if not isinstance(summary, str) or not summary.strip():
                summary = join_summary(payload)
            return StatusToolResult(
                tool_name=tool_name,
                payload=payload,
                summary=summary.strip(),
            )

        if tool_name == SMS_TOOL_SHIPS:
            result = await game_client.list_user_ships(character_id=character_id)
            return StatusToolResult(
                tool_name=tool_name,
                payload=result,
                summary=ships_list_summary(result).strip(),
            )

        result = await game_client._request("my_corporation", {"character_id": character_id})
        return StatusToolResult(
            tool_name=tool_name,
            payload=result,
            summary=summarize_corporation_info(result).strip(),
        )


def is_status_request(message: str | None) -> bool:
    """Return true when the SMS turn is asking for the status tool."""
    normalized = " ".join((message or "").strip().lower().split()).strip("!.?")
    if normalized in STATUS_REQUEST_WORDS:
        return True
    tokens = set(normalized.replace("?", " ").replace(".", " ").split())
    return bool(tokens & SUPPORTED_STATUS_HINTS)


def is_greeting_request(message: str | None) -> bool:
    """Return true when the SMS turn is a simple conversational greeting."""
    normalized = " ".join((message or "").strip().lower().split()).strip("!.?")
    return normalized in GREETING_WORDS


def is_identity_request(message: str | None) -> bool:
    """Return true when the SMS turn asks about the configured character identity."""
    normalized = " ".join((message or "").strip().lower().split()).strip("!.?")
    return normalized in IDENTITY_REQUESTS


def select_tool(message: str | None) -> Optional[str]:
    """Select the SMS tool requested by this one-turn message."""
    normalized = " ".join((message or "").strip().lower().split()).strip("!.?")
    normalized = normalized.replace("_", " ")
    if normalized == SMS_TOOL_STATUS:
        return SMS_TOOL_STATUS
    if normalized == SMS_TOOL_SHIPS:
        return SMS_TOOL_SHIPS
    if normalized == SMS_TOOL_MAP:
        return SMS_TOOL_MAP
    if normalized in {"corporation", "corporation info"}:
        return SMS_TOOL_CORPORATION
    tokens = set(normalized.replace("?", " ").replace(".", " ").split())
    if tokens & SUPPORTED_CORPORATION_HINTS:
        return SMS_TOOL_CORPORATION
    if tokens & SUPPORTED_SHIPS_HINTS or "ship list" in normalized or "my ships" in normalized:
        return SMS_TOOL_SHIPS
    if tokens & SUPPORTED_MAP_HINTS or "star chart" in normalized or "sector map" in normalized:
        return SMS_TOOL_MAP
    if is_status_request(normalized):
        return SMS_TOOL_STATUS
    return None


def _fallback_tool_reply(
    tool_name: str,
    summary: str,
    *,
    character: CharacterContext | None = None,
    is_first_turn: bool = False,
) -> str:
    """Return a deterministic SMS report if the LLM yields no text."""
    lines = [line.strip() for line in summary.splitlines() if line.strip()]
    if not lines:
        return "Commander, telemetry is available, but the summary channel is blank."
    compact = " ".join(lines[:5])
    labels = {
        SMS_TOOL_STATUS: "status report",
        SMS_TOOL_SHIPS: "fleet report",
        SMS_TOOL_CORPORATION: "corporation report",
        SMS_TOOL_MAP: "cartography report",
    }
    if is_first_turn and character and character.name:
        return f"Commander {character.name}, {labels.get(tool_name, 'report')}: {compact}"
    return f"Commander, {labels.get(tool_name, 'report')}: {compact}"


def _fallback_greeting_reply(*, character: CharacterContext, is_first_turn: bool) -> str:
    if is_first_turn and character.name:
        return f"Commander {character.name}, ship intelligence is online."
    return "Commander, ship intelligence is online."


def _fallback_general_reply(*, character: CharacterContext, is_first_turn: bool) -> str:
    if is_first_turn and character.name:
        return f"Commander {character.name}, ship intelligence received your message."
    return "Commander, ship intelligence received your message."


def _character_identity_context(
    *,
    character: CharacterContext,
    is_first_turn: bool,
) -> str:
    """Build compact commander identity context for the SMS LLM."""
    name = character.name or "unknown"
    created_at = character.created_at or "unknown"
    return (
        f"<commander_identity first_sms_turn=\"{str(is_first_turn).lower()}\">\n"
        f"Character Name: {name}\n"
        f"Character ID: {character.character_id}\n"
        f"Character Created At: {created_at}\n"
        "</commander_identity>"
    )


async def run_turn_response(
    message: str,
    character_id: str,
    access_token: Optional[str] = None,
) -> SmsTurnResponse:
    """Run one stateless SMS-agent turn and return the text/media reply."""
    user_message = (message or "").strip()
    if not user_message:
        return SmsTurnResponse(
            text="Send a message and I will check your current Gradient Bang status."
        )
    tool_name = select_tool(user_message)
    is_greeting = tool_name is None and is_greeting_request(user_message)
    is_identity = tool_name is None and is_identity_request(user_message)

    character = await fetch_character_context(
        character_id=character_id,
        access_token=access_token,
    )
    is_first_turn = not has_greeted_character(character_id)
    mark_character_greeted(character_id)
    set_prompt_substitutions(
        personality_tone=os.getenv("SMS_AGENT_PERSONALITY_TONE") or DEFAULT_PERSONALITY_TONE,
        language_instruction="",
    )
    prompt = build_sms_agent_prompt()

    context_messages = [
        {"role": "system", "content": prompt},
        {
            "role": "user",
            "content": _character_identity_context(
                character=character,
                is_first_turn=is_first_turn,
            ),
        },
    ]

    tool_result: StatusToolResult | None = None
    if tool_name is not None:
        tool_result = await fetch_tool_result(
            tool_name=tool_name,
            character_id=character_id,
            access_token=access_token,
        )
        context_messages.extend(
            [
                {
                    "role": "user",
                    "content": (
                        f"<sms_tool_result tool=\"{tool_name}\">\n"
                        f"{tool_result.summary}\n"
                        "</sms_tool_result>"
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"<sms_tool_instruction tool=\"{tool_name}\">\n"
                        "The requested tool has run successfully. Reply in character "
                        "with a concise summary using only sms_tool_result.\n"
                        "</sms_tool_instruction>"
                    ),
                },
            ]
        )
    elif is_greeting:
        context_messages.append(
            {
                "role": "user",
                "content": (
                    "<sms_greeting_instruction>\n"
                    "The commander is opening the SMS channel. Reply naturally in the "
                    "ship-AI voice. Do not list supported tools or commands unless asked.\n"
                    "</sms_greeting_instruction>"
                ),
            },
        )
    elif is_identity:
        context_messages.append(
            {
                "role": "user",
                "content": (
                    "<sms_identity_instruction>\n"
                    "The commander is asking who they are. Answer from "
                    "commander_identity only, in the ship-AI voice. If the "
                    "character name is unknown, say identity telemetry is unavailable.\n"
                    "</sms_identity_instruction>"
                ),
            },
        )
    else:
        context_messages.append(
            {
                "role": "user",
                "content": (
                    "<sms_general_instruction>\n"
                    "Answer the commander's message through normal inference in the "
                    "ship-AI voice. Use commander_identity when relevant. If the "
                    "message asks for a game action you cannot perform through SMS, "
                    "say so naturally and briefly instead of listing commands.\n"
                    "</sms_general_instruction>"
                ),
            },
        )

    if tool_name == SMS_TOOL_STATUS and tool_result is not None:
        context_messages.insert(
            1,
            {
                "role": "user",
                "content": (
                    "<current_status>\n"
                    f"{tool_result.summary}\n"
                    "</current_status>"
                ),
            },
        )
    context_messages.append({"role": "user", "content": user_message})

    context = LLMContext(
        messages=context_messages,
    )

    llm = create_llm_service(get_sms_agent_llm_config())
    logger.info(
        "sms_agent.run_turn tool={} greeting={} identity={} message_chars={} summary_chars={} first_turn={} character_name={!r}",
        tool_name,
        is_greeting,
        is_identity,
        len(user_message),
        len(tool_result.summary) if tool_result is not None else 0,
        is_first_turn,
        character.name,
    )
    response = await llm.run_inference(context)
    media_url = None
    if tool_name == SMS_TOOL_MAP and tool_result is not None:
        payload_media_url = tool_result.payload.get("image_url")
        media_url = payload_media_url if isinstance(payload_media_url, str) else None
    if not response or not response.strip():
        logger.warning(
            "sms_agent.run_turn empty_llm_response tool={}",
            tool_name,
        )
        if tool_result is None:
            if is_greeting:
                return SmsTurnResponse(
                    text=_fallback_greeting_reply(
                        character=character,
                        is_first_turn=is_first_turn,
                    )
                )
            return SmsTurnResponse(
                text=_fallback_general_reply(
                    character=character,
                    is_first_turn=is_first_turn,
                )
            )
        return SmsTurnResponse(
            text=_fallback_tool_reply(
                tool_name,
                tool_result.summary,
                character=character,
                is_first_turn=is_first_turn,
            ),
            media_url=media_url,
        )
    return SmsTurnResponse(text=response.strip(), media_url=media_url)


async def run_turn(
    message: str,
    character_id: str,
    access_token: Optional[str] = None,
) -> str:
    """Run one stateless SMS-agent turn and return only the text reply."""
    response = await run_turn_response(
        message=message,
        character_id=character_id,
        access_token=access_token,
    )
    return response.text
