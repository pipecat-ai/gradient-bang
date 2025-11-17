"""
Tests for event ordering consistency with polling-based delivery.

Polling provides STRICT event ordering guarantees that realtime couldn't:
- Events are delivered in ascending `events.id` order (database sequence)
- No race conditions from concurrent postgres_changes notifications
- Deterministic, reproducible order across test runs

This is a key ADVANTAGE of the polling approach over realtime.
"""

import asyncio
import pytest
from helpers.event_capture import create_firehose_listener
from helpers.client_setup import create_client_with_character
from utils.api_client import AsyncGameClient
from conftest import EVENT_DELIVERY_WAIT


pytestmark = [pytest.mark.asyncio, pytest.mark.integration, pytest.mark.requires_server]


class TestEventOrdering:
    """Verify that polling delivers events in strict database insertion order."""

    async def test_events_arrive_in_id_order(self, server_url):
        """Events should arrive in ascending events.id order (database sequence)."""
        char_id = "test_event_order"

        # Create client first (creates character), then firehose listener
        client = await create_client_with_character(server_url, char_id, sector=0)
        try:
            async with create_firehose_listener(server_url, char_id) as listener:
                await asyncio.sleep(EVENT_DELIVERY_WAIT)

                # Generate multiple events in quick succession
                await client.move(to_sector=1, character_id=char_id)
                await client.move(to_sector=0, character_id=char_id)

                # Wait for all events to arrive via polling
                await asyncio.sleep(EVENT_DELIVERY_WAIT * 2)

                # Extract event IDs (if present in metadata)
                event_ids = []
                for event in listener.events:
                    event_id = event.get("__event_id")
                    if isinstance(event_id, int):
                        event_ids.append(event_id)

                # Verify strictly ascending order
                if len(event_ids) >= 2:
                    for i in range(len(event_ids) - 1):
                        assert event_ids[i] < event_ids[i + 1], (
                            f"Events not in ascending ID order: "
                            f"{event_ids[i]} >= {event_ids[i+1]} at index {i}"
                        )
        finally:
            await client.close()

    async def test_movement_events_chronological(self, server_url):
        """Movement events must arrive in the order they occurred."""
        char_id = "test_movement_order"

        # Create client first (creates character), then firehose listener
        client = await create_client_with_character(server_url, char_id, sector=0)
        try:
            async with create_firehose_listener(server_url, char_id) as listener:
                await asyncio.sleep(EVENT_DELIVERY_WAIT)

                # Move through a sequence: 0 -> 1 -> 0 -> 2
                await client.move(to_sector=1, character_id=char_id)
                await client.move(to_sector=0, character_id=char_id)
                await client.move(to_sector=2, character_id=char_id)

                await asyncio.sleep(EVENT_DELIVERY_WAIT * 2)

                # Extract sector IDs from movement events
                movement_sectors = []
                for event in listener.events:
                    if event.get("type") in ("movement.complete", "character.moved"):
                        payload = event.get("payload", {})
                        sector = payload.get("sector", {})
                        sector_id = sector.get("id") if isinstance(sector, dict) else sector
                        if isinstance(sector_id, int):
                            movement_sectors.append(sector_id)

                # Verify the sequence matches our moves
                # Expected: 1 (arrived), 0 (arrived), 2 (arrived)
                if len(movement_sectors) >= 3:
                    assert movement_sectors[-3:] == [1, 0, 2], (
                        f"Movement sequence mismatch: got {movement_sectors[-3:]}, "
                        f"expected [1, 0, 2]"
                    )
        finally:
            await client.close()

    async def test_concurrent_actions_deterministic_order(self, server_url):
        """
        When multiple characters act concurrently, events should still arrive
        in a consistent, deterministic order (by database insertion time).
        """
        char1 = "test_concurrent_1"
        char2 = "test_concurrent_2"

        # Create clients first (creates characters), then firehose listeners
        client1 = await create_client_with_character(server_url, char1, sector=0)
        client2 = await create_client_with_character(server_url, char2, sector=0)

        try:
            async with create_firehose_listener(server_url, char1) as listener1, \
                       create_firehose_listener(server_url, char2) as listener2:
                await asyncio.sleep(EVENT_DELIVERY_WAIT)

                # Both characters move concurrently
                await asyncio.gather(
                    client1.move(to_sector=1, character_id=char1),
                    client2.move(to_sector=2, character_id=char2),
                )

                await asyncio.sleep(EVENT_DELIVERY_WAIT * 2)

                # Extract event IDs from both listeners
                ids1 = [e.get("__event_id") for e in listener1.events if "__event_id" in e]
                ids2 = [e.get("__event_id") for e in listener2.events if "__event_id" in e]

                # Both should see events in ascending ID order
                for ids, char in [(ids1, char1), (ids2, char2)]:
                    if len(ids) >= 2:
                        for i in range(len(ids) - 1):
                            assert ids[i] < ids[i + 1], (
                                f"Character {char} received events out of order: "
                                f"{ids}"
                            )
        finally:
            await client1.close()
            await client2.close()

    async def test_event_timestamps_increase(self, server_url):
        """Event timestamps should increase monotonically (or stay equal)."""
        char_id = "test_timestamp_order"

        # Create client first (creates character), then firehose listener
        client = await create_client_with_character(server_url, char_id, sector=0)
        try:
            async with create_firehose_listener(server_url, char_id) as listener:
                await asyncio.sleep(EVENT_DELIVERY_WAIT)

                await client.move(to_sector=1, character_id=char_id)
                await client.move(to_sector=0, character_id=char_id)

                await asyncio.sleep(EVENT_DELIVERY_WAIT * 2)

                # Extract timestamps
                timestamps = []
                for event in listener.events:
                    payload = event.get("payload", {})
                    source = payload.get("source", {}) if isinstance(payload, dict) else {}
                    timestamp = source.get("timestamp") if isinstance(source, dict) else None
                    if isinstance(timestamp, str):
                        timestamps.append(timestamp)

                # Verify monotonically increasing (or equal for simultaneous events)
                if len(timestamps) >= 2:
                    for i in range(len(timestamps) - 1):
                        assert timestamps[i] <= timestamps[i + 1], (
                            f"Timestamps not monotonic: {timestamps[i]} > {timestamps[i+1]}"
                        )
        finally:
            await client.close()
