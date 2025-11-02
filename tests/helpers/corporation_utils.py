"""Shared helpers for corporation integration tests."""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator

from utils.api_client import AsyncGameClient
from helpers.combat_helpers import create_test_character_knowledge


RESET_PREFIXES = ["corp_events_", "corp_filter_"]


async def reset_corporation_test_state(server_url: str) -> None:
    """Clear cached server state for corporation-focused integration tests."""

    client = AsyncGameClient(base_url=server_url, character_id="test_event_character")
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
    if ships_path.exists():
        ships_path.unlink()


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

    client = AsyncGameClient(base_url=server_url, character_id=character_id)
    await client.join(character_id=character_id)

    try:
        yield client
    finally:
        await client.close()
