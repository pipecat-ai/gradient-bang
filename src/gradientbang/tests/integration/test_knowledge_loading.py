"""Test to verify join() loads existing character knowledge."""
import asyncio

import pytest

from gradientbang.tests.helpers.combat_helpers import create_test_character_knowledge
from gradientbang.utils.api_client import AsyncGameClient

pytestmark = [pytest.mark.asyncio, pytest.mark.integration, pytest.mark.requires_server]


async def test_join_loads_existing_knowledge():
    """Verify that join() loads existing knowledge file when it exists."""
    server_url = "http://localhost:8002"
    char_id = "test_trader_at_port"  # This IS in TEST_CHARACTER_IDS

    # Step 1: Create knowledge file with visited sectors
    print("\n=== Step 1: Creating knowledge file ===")
    path = create_test_character_knowledge(
        char_id,
        sector=1,
        visited_sectors=[0, 1, 3, 5, 9],
        credits=100000
    )
    print(f"Created: {path}")
    print(f"Exists: {path.exists()}")
    print(f"Size: {path.stat().st_size if path.exists() else 0} bytes")

    assert path.exists(), "Knowledge file should exist"

    # Read the file to verify it has 5 sectors
    import json
    with open(path, "r") as f:
        data = json.load(f)
    print(f"Sectors in file: {list(data['sectors_visited'].keys())}")
    assert len(data['sectors_visited']) == 5, "Should have 5 sectors in knowledge file"

    # Ensure file is fully written
    path.resolve().stat()  # Force filesystem sync
    print(f"File still exists after stat(): {path.exists()}")

    # Step 2: Call join()
    print("\n=== Step 2: Calling join() ===")
    client = AsyncGameClient(base_url=server_url, character_id=char_id)
    try:
        result = await client.join(character_id=char_id)
        print(f"Join result: {result.get('sector', {}).get('id', 'unknown')}")

        # Step 3: Get status by waiting for status.snapshot event
        print("\n=== Step 3: Checking status ===")

        # Set up event listener before making the request
        status_received = asyncio.Future()

        def on_status(event):
            if not status_received.done():
                status_received.set_result(event.get("payload", event))

        token = client.add_event_handler("status.snapshot", on_status)

        try:
            # Make the request
            await client.my_status(character_id=char_id)

            # Wait for the event with timeout
            status = await asyncio.wait_for(status_received, timeout=5.0)
        finally:
            client.remove_event_handler(token)

        # Debug: Print full status structure
        import json
        print(f"Full status keys: {list(status.keys())}")
        print(f"Status has 'character' key: {'character' in status}")
        print(f"Status has 'player' key: {'player' in status}")

        # The status doesn't include map knowledge directly
        # Knowledge is stored server-side and accessed via list_known_ports

        # Step 4: Verify knowledge by checking if we can find ports
        print("\n=== Step 4: Verifying knowledge via list_known_ports ===")

        # Set up event listener for ports.list event
        ports_received = asyncio.Future()

        def on_ports_list(event):
            if not ports_received.done():
                ports_received.set_result(event.get("payload", event))

        token = client.add_event_handler("ports.list", on_ports_list)

        try:
            # Make the request
            await client.list_known_ports(character_id=char_id, max_hops=10)

            # Wait for the event with timeout
            ports_result = await asyncio.wait_for(ports_received, timeout=5.0)
        finally:
            client.remove_event_handler(token)

        ports = ports_result.get("ports", [])

        print(f"Ports found: {len(ports)}")
        if ports:
            for port in ports:
                sector_info = port.get("sector", {})
                port_info = sector_info.get("port", {})
                print(f"  - Sector {sector_info.get('id', 'unknown')}: {port_info.get('code', 'unknown')}")

        # We should find 4 ports (sectors 1, 3, 5, 9 all have ports)
        if len(ports) >= 4:
            print(f"✅ SUCCESS: Knowledge was preserved! Found {len(ports)} ports")
        else:
            print(f"❌ FAILURE: Knowledge was NOT preserved. Expected 4+ ports, got {len(ports)}")
            pytest.fail(f"Knowledge was not preserved during join(). Expected 4+ ports, got {len(ports)}")

    finally:
        await client.close()
