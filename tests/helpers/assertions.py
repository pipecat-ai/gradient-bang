"""
Custom assertions for common test patterns.

This module provides specialized assertion helpers for validating events,
character state, and other game-specific conditions.
"""

from typing import List, Dict, Any, Optional, Set


# =============================================================================
# Event Assertions (CRITICAL - most tests need these)
# =============================================================================

def assert_event_emitted(events: List[Dict[str, Any]], event_type: str) -> Dict[str, Any]:
    """
    Assert that an event type was emitted.

    Args:
        events: List of event dictionaries
        event_type: Expected event type (e.g., "character.joined")

    Returns:
        The first matching event

    Raises:
        AssertionError: If event type not found
    """
    for event in events:
        if event.get("type") == event_type:
            return event

    event_types = [e.get("type") for e in events]
    raise AssertionError(
        f"Event type '{event_type}' not found. "
        f"Received events: {event_types}"
    )


def assert_event_order(events: List[Dict[str, Any]], expected_types: List[str]):
    """
    Validate that events occur in the expected order.

    Args:
        events: List of event dictionaries
        expected_types: List of event types in expected order

    Raises:
        AssertionError: If events don't match expected order
    """
    event_types = [e.get("type") for e in events]

    # Find positions of expected types
    positions = []
    for expected_type in expected_types:
        try:
            pos = event_types.index(expected_type)
            positions.append(pos)
        except ValueError:
            raise AssertionError(
                f"Event '{expected_type}' not found in events. "
                f"Received: {event_types}"
            )

    # Check that positions are in order
    if positions != sorted(positions):
        raise AssertionError(
            f"Events not in expected order. "
            f"Expected: {expected_types}, "
            f"Received: {event_types}"
        )


def assert_event_payload(event: Dict[str, Any], expected_fields: Dict[str, Any]):
    """
    Validate that an event contains expected fields with expected values.

    Args:
        event: Event dictionary
        expected_fields: Dictionary of field name -> expected value

    Raises:
        AssertionError: If any field is missing or has wrong value
    """
    for field, expected_value in expected_fields.items():
        if field not in event:
            raise AssertionError(
                f"Event missing required field '{field}'. "
                f"Event: {event}"
            )

        actual_value = event[field]
        if actual_value != expected_value:
            raise AssertionError(
                f"Event field '{field}' has wrong value. "
                f"Expected: {expected_value}, Actual: {actual_value}"
            )


def assert_event_count(events: List[Dict[str, Any]], event_type: str, count: int):
    """
    Assert that an event type occurs exactly N times.

    Args:
        events: List of event dictionaries
        event_type: Event type to count
        count: Expected count

    Raises:
        AssertionError: If count doesn't match
    """
    actual_count = sum(1 for e in events if e.get("type") == event_type)

    if actual_count != count:
        raise AssertionError(
            f"Event '{event_type}' occurred {actual_count} times, "
            f"expected {count}"
        )


def assert_no_event_emitted(events: List[Dict[str, Any]], event_type: str):
    """
    Assert that an event type was NOT emitted.

    Args:
        events: List of event dictionaries
        event_type: Event type that should not be present

    Raises:
        AssertionError: If event type is found
    """
    for event in events:
        if event.get("type") == event_type:
            raise AssertionError(
                f"Event '{event_type}' should not be emitted, but was found: {event}"
            )


def assert_events_chronological(events: List[Dict[str, Any]]):
    """
    Assert that events have monotonically increasing timestamps.

    Args:
        events: List of event dictionaries

    Raises:
        AssertionError: If timestamps are not chronological
    """
    timestamps = [e.get("timestamp") for e in events]

    for i in range(1, len(timestamps)):
        if timestamps[i] < timestamps[i - 1]:
            raise AssertionError(
                f"Events not chronological. "
                f"Event {i-1} timestamp: {timestamps[i-1]}, "
                f"Event {i} timestamp: {timestamps[i]}"
            )


def assert_event_filtered_to(
    event: Dict[str, Any],
    character_ids: Optional[Set[str]] = None
):
    """
    Check that event was sent to correct clients (privacy validation).

    Note: This is a placeholder - actual filtering validation requires
    multiple client connections to verify WHO receives WHAT events.

    Args:
        event: Event dictionary
        character_ids: Set of character IDs that should receive this event

    Raises:
        AssertionError: If event filtering is incorrect
    """
    # This is a placeholder - actual implementation would require
    # connecting multiple clients and verifying event delivery
    pass


# =============================================================================
# Character State Assertions
# =============================================================================

def assert_character_at_sector(character_dict: Dict[str, Any], sector: int):
    """
    Assert that character is at a specific sector.

    Args:
        character_dict: Character state dictionary
        sector: Expected sector number

    Raises:
        AssertionError: If character is not at expected sector
    """
    actual_sector = character_dict.get("sector")
    if actual_sector != sector:
        raise AssertionError(
            f"Character not at expected sector. "
            f"Expected: {sector}, Actual: {actual_sector}"
        )


def assert_inventory_contains(
    character_dict: Dict[str, Any],
    commodity: str,
    quantity: int
):
    """
    Assert that character inventory contains a specific commodity quantity.

    Args:
        character_dict: Character state dictionary
        commodity: Commodity name
        quantity: Expected quantity

    Raises:
        AssertionError: If inventory doesn't match
    """
    inventory = character_dict.get("inventory", {})
    actual_quantity = inventory.get(commodity, 0)

    if actual_quantity != quantity:
        raise AssertionError(
            f"Inventory mismatch for '{commodity}'. "
            f"Expected: {quantity}, Actual: {actual_quantity}"
        )


def assert_credits_equal(character_dict: Dict[str, Any], amount: int):
    """
    Assert that character has expected credits.

    Args:
        character_dict: Character state dictionary
        amount: Expected credit amount

    Raises:
        AssertionError: If credits don't match
    """
    actual_credits = character_dict.get("credits", 0)
    if actual_credits != amount:
        raise AssertionError(
            f"Credits mismatch. Expected: {amount}, Actual: {actual_credits}"
        )


def assert_in_combat(character_dict: Dict[str, Any]):
    """
    Assert that character is in combat.

    Args:
        character_dict: Character state dictionary

    Raises:
        AssertionError: If character is not in combat
    """
    in_combat = character_dict.get("in_combat", False)
    if not in_combat:
        raise AssertionError("Character should be in combat but is not")


def assert_hyperspace_flag(character_dict: Dict[str, Any], expected: bool):
    """
    Assert that character's hyperspace flag matches expected value.

    Args:
        character_dict: Character state dictionary
        expected: Expected hyperspace flag value

    Raises:
        AssertionError: If hyperspace flag doesn't match
    """
    actual = character_dict.get("in_hyperspace", False)
    if actual != expected:
        raise AssertionError(
            f"Hyperspace flag mismatch. Expected: {expected}, Actual: {actual}"
        )


# =============================================================================
# General Assertions
# =============================================================================

async def assert_within_timeout(coro, timeout: float = 5.0):
    """
    Assert that an async operation completes within timeout.

    Args:
        coro: Coroutine to execute
        timeout: Maximum time in seconds (default: 5.0)

    Raises:
        asyncio.TimeoutError: If operation doesn't complete in time
    """
    import asyncio
    async with asyncio.timeout(timeout):
        return await coro
