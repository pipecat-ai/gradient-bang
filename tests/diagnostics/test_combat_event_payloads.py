"""Diagnostic script to capture and display combat event payloads."""

import asyncio
import json
from pathlib import Path

from gradientbang.utils.api_client import AsyncGameClient
from helpers.combat_helpers import (
    create_strong_character,
    create_weak_character,
    set_character_cargo,
)


class EventLogger:
    """Capture and display all events."""

    def __init__(self, name):
        self.name = name
        self.events = []

    def log_event(self, event_name, payload):
        self.events.append((event_name, payload))
        print(f"\n{'='*80}")
        print(f"[{self.name}] Received: {event_name}")
        print(f"{'='*80}")
        print(json.dumps(payload, indent=2, default=str))
        print(f"{'='*80}\n")


async def main():
    """Run a simple combat scenario and log all events."""

    # Setup
    print("Setting up characters...")
    create_strong_character("diagnostic_attacker", sector=0, fighters=500)
    create_weak_character("diagnostic_victim", sector=0, fighters=5)
    set_character_cargo("diagnostic_victim", quantum_foam=10, retro_organics=5)

    attacker_logger = EventLogger("ATTACKER")
    victim_logger = EventLogger("VICTIM")

    attacker = AsyncGameClient(
        base_url="http://localhost:8002",
        character_id="diagnostic_attacker",
        transport="websocket",
    )

    victim = AsyncGameClient(
        base_url="http://localhost:8002",
        character_id="diagnostic_victim",
        transport="websocket",
    )

    # Register ALL combat event handlers
    attacker.on("combat.round_waiting")(lambda p: attacker_logger.log_event("combat.round_waiting", p))
    attacker.on("combat.round_resolved")(lambda p: attacker_logger.log_event("combat.round_resolved", p))
    attacker.on("combat.ended")(lambda p: attacker_logger.log_event("combat.ended", p))
    attacker.on("sector.update")(lambda p: attacker_logger.log_event("sector.update", p))

    victim.on("combat.round_waiting")(lambda p: victim_logger.log_event("combat.round_waiting", p))
    victim.on("combat.round_resolved")(lambda p: victim_logger.log_event("combat.round_resolved", p))
    victim.on("combat.ended")(lambda p: victim_logger.log_event("combat.ended", p))

    try:
        # Execute combat
        print("Joining characters...")
        await attacker.join("diagnostic_attacker")
        await victim.join("diagnostic_victim")

        print("\nInitiating combat...")
        await attacker.combat_initiate(character_id="diagnostic_attacker")

        await asyncio.sleep(2.0)  # Wait for combat.round_waiting

        # Get combat_id from first event
        combat_id = attacker_logger.events[0][1]["combat_id"]

        print(f"\nSubmitting actions for combat_id: {combat_id}...")
        await attacker.combat_action(
            character_id="diagnostic_attacker",
            combat_id=combat_id,
            action="attack",
            target_id="diagnostic_victim",
            commit=200,
        )

        await victim.combat_action(
            character_id="diagnostic_victim",
            combat_id=combat_id,
            action="brace",
            commit=0,
        )

        print("\nWaiting for combat resolution (10 seconds)...")
        await asyncio.sleep(10.0)

        print("\n" + "="*80)
        print("SUMMARY OF EVENTS")
        print("="*80)
        print(f"\nAttacker received {len(attacker_logger.events)} events:")
        for event_name, _ in attacker_logger.events:
            print(f"  - {event_name}")

        print(f"\nVictim received {len(victim_logger.events)} events:")
        for event_name, _ in victim_logger.events:
            print(f"  - {event_name}")

    finally:
        await attacker.close()
        await victim.close()


if __name__ == "__main__":
    asyncio.run(main())
