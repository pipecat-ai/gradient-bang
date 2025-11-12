"""Shared helpers for corporation integration tests."""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator

from utils import api_client as _api_client_module
from helpers.combat_helpers import create_test_character_knowledge

REQUIRED_CORPORATION_FUNCTIONS = (
    "corporation_create",
    "corporation_join",
    "corporation_leave",
    "corporation_kick",
    "corporation_regenerate_invite_code",
    "corporation_list",
    "corporation_info",
    "my_corporation",
)


RESET_PREFIXES = ["corp_events_", "corp_filter_"]

_TRUTHY = {"1", "true", "on", "yes"}


async def reset_corporation_test_state(server_url: str) -> None:
    """Clear cached server state for corporation-focused integration tests."""

    client = _api_client_module.AsyncGameClient(base_url=server_url, character_id="test_event_character")
    try:
        await client.join(character_id="test_event_character")
        await client._request(
            "test.reset",
            {
                "clear_files": True,
                "file_prefixes": RESET_PREFIXES,
            },
        )
    finally:
        await client.close()

    ships_path = Path("tests/test-world-data/ships.json")
    ships_path.parent.mkdir(parents=True, exist_ok=True)
    ships_path.write_text("{}\n", encoding="utf-8")

    event_log_path = Path("tests/test-world-data/event-log.jsonl")
    event_log_path.parent.mkdir(parents=True, exist_ok=True)
    event_log_path.write_text("", encoding="utf-8")


@asynccontextmanager
async def managed_client(
    server_url: str,
    character_id: str,
    *,
    credits: int = 60_000,
    bank: int = 0,
    sector: int = 1,
) -> AsyncGenerator[AsyncGameClient, None]:
    """Yield a connected AsyncGameClient with seeded character knowledge."""

    create_test_character_knowledge(
        character_id,
        sector=sector,
        credits=credits,
        credits_in_bank=bank,
    )

    client = _api_client_module.AsyncGameClient(base_url=server_url, character_id=character_id)
    await client.join(character_id=character_id)

    try:
        yield client
    finally:
        await client.close()
