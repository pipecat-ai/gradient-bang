"""
Helper functions for creating test clients with pre-configured characters.

This module provides utilities for setting up AsyncGameClient instances with
properly initialized characters in both Legacy and Supabase test environments.
"""

import os
from typing import Dict, Optional, Any
from gradientbang.utils.api_client import AsyncGameClient
from tests.helpers.combat_helpers import create_test_character_knowledge


def register_characters_for_test(*character_ids: str) -> None:
    """Register characters in Supabase database for current test.

    For Supabase tests, this calls test_reset with the specified character IDs
    to insert them into the database. This is required because:
    - test_reset truncates the characters table between tests
    - create_test_character_knowledge() writes to JSON files (legacy system)
    - Supabase needs characters in the DATABASE table for join() to work

    For Legacy tests, this is a no-op (characters use JSON files).

    IMPORTANT: Call this BEFORE creating clients or calling join().

    Args:
        *character_ids: Character IDs to register in the database

    Example:
        register_characters_for_test('test_char1', 'test_char2')
        client = AsyncGameClient(base_url=server_url, character_id='test_char1')
        await client.join()  # Now works!

    Note:
        - This function is idempotent - safe to call multiple times
        - Only registers characters, does NOT create ships or knowledge
        - Use create_test_character_knowledge() to set up ship/stats
    """
    import httpx

    if not os.getenv('USE_SUPABASE_TESTS'):
        return  # Legacy: use JSON files

    # Call test_reset with character IDs to insert them into database
    edge_url = os.getenv('EDGE_FUNCTIONS_URL', 'http://127.0.0.1:54321/functions/v1')
    api_token = os.getenv('EDGE_API_TOKEN', 'local-dev-token')
    headers = {
        'Content-Type': 'application/json',
        'x-api-token': api_token  # test_reset expects x-api-token header, not Authorization
    }

    try:
        resp = httpx.post(
            f"{edge_url}/test_reset",
            headers=headers,
            json={"character_ids": list(character_ids)},
            timeout=30.0,
        )
        resp.raise_for_status()
        payload = resp.json()
        if not payload.get('success'):
            raise RuntimeError(f"test_reset returned failure: {payload}")
    except httpx.HTTPError as e:
        raise RuntimeError(f"Failed to register characters {character_ids}: {e}") from e


async def create_client_with_character(
    server_url: str,
    character_id: str,
    *,
    sector: int = 0,
    credits: int = 1000,
    credits_in_bank: int = 0,
    fighters: int = 300,
    shields: int = 150,
    warp_power: int = 300,
    ship_type: str = "kestrel_courier",
    ship_name: Optional[str] = None,
    visited_sectors: Optional[list[int]] = None,
    cargo: Optional[Dict[str, int]] = None,
    modules: Optional[list[str]] = None,
    **kwargs: Any
) -> AsyncGameClient:
    """
    Create a test character and return an authenticated AsyncGameClient.

    This function:
    1. Creates the character in the database (Supabase) or filesystem (Legacy)
    2. Initializes the client
    3. Calls join() to authenticate
    4. Returns the ready-to-use client

    The character is automatically created in both Legacy (world-data/) and Supabase
    (database tables) depending on the USE_SUPABASE_TESTS environment variable.

    Args:
        server_url: Base URL of the test server
        character_id: Unique character identifier
        sector: Starting sector (default: 0)
        credits: Starting credits (default: 1000)
        credits_in_bank: Credits in megabank (default: 0)
        fighters: Fighter count (default: 300)
        shields: Shield strength (default: 150)
        warp_power: Warp power (default: 300)
        ship_type: Ship type (default: "kestrel_courier")
        ship_name: Custom ship name (default: None, auto-generated)
        visited_sectors: List of pre-visited sectors (default: None)
        cargo: Cargo dictionary (default: None, empty holds)
        modules: Ship modules (default: None)
        **kwargs: Additional arguments passed to create_test_character_knowledge()

    Returns:
        AsyncGameClient: Authenticated client ready for test operations

    Example:
        >>> client = await create_client_with_character(
        ...     server_url,
        ...     "test_char",
        ...     sector=5,
        ...     credits=50_000,
        ...     fighters=500
        ... )
        >>> async with client:
        ...     status = await client.my_status(character_id="test_char")
    """
    # Create character in database/filesystem
    create_test_character_knowledge(
        character_id,
        sector=sector,
        credits=credits,
        credits_in_bank=credits_in_bank,
        fighters=fighters,
        shields=shields,
        warp_power=warp_power,
        ship_type=ship_type,
        ship_name=ship_name,
        visited_sectors=visited_sectors,
        cargo=cargo,
        modules=modules,
        **kwargs
    )

    # Create client and join
    # Note: For Supabase, event delivery uses HTTP polling (set SUPABASE_USE_POLLING=1)
    # For Legacy, event delivery uses WebSocket (no env var needed)
    client = AsyncGameClient(base_url=server_url, character_id=character_id)
    await client.join(character_id=character_id)

    return client
