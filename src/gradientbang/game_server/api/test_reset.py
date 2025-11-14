"""Test utilities for resetting server state between tests.

WARNING: This endpoint clears all game state and should only be used in test environments.
"""

import logging
from pathlib import Path
import json
from gradientbang.utils.config import get_world_data_path

logger = logging.getLogger("gradient-bang.api.test_reset")


async def handle(request: dict, world) -> dict:
    """Reset all server state for test isolation.

    This endpoint:
    - Clears all characters from memory
    - Clears combat manager encounters
    - Clears salvage manager state
    - Clears garrison manager state
    - Clears knowledge manager cache
    - Optionally deletes test character knowledge files from disk
    - Resets garrison JSON file
    - Resets all ports to initial universe state (inventory, cache, files)

    Args:
        request: {
            "clear_files": bool (optional) - If True, delete test character files from disk
            "file_prefixes": list[str] (optional) - Prefixes to match for file deletion
        }

    Returns:
        dict: {
            "cleared_characters": int,
            "cleared_combats": int,
            "cleared_salvage": int,
            "cleared_garrisons": int,
            "cleared_cache": int,
            "deleted_files": int,
            "ports_reset": int
        }
    """
    clear_files = request.get("clear_files", True)
    file_prefixes = request.get("file_prefixes", [
        "test_", "weak_", "strong_", "player", "attacker", "defender",
        "victim", "deployer", "payer", "enemy", "observer", "combatant",
        "garrison_", "toll_", "def_", "salvage_"
    ])

    # Clear in-memory state
    cleared_characters = len(world.characters)
    world.characters.clear()
    logger.info(f"Cleared {cleared_characters} characters from memory")

    # Clear combat manager
    cleared_combats = 0
    if hasattr(world, "combat_manager") and world.combat_manager:
        cleared_combats = len(world.combat_manager._encounters)
        world.combat_manager._encounters.clear()
        logger.info(f"Cleared {cleared_combats} combat encounters")

    # Clear salvage manager
    cleared_salvage = 0
    if hasattr(world, "salvage_manager") and world.salvage_manager:
        cleared_salvage = len(world.salvage_manager._by_sector)
        world.salvage_manager._by_sector.clear()
        logger.info(f"Cleared {cleared_salvage} salvage entries")

    # Clear garrison manager
    cleared_garrisons = 0
    if hasattr(world, "garrisons") and world.garrisons:
        cleared_garrisons = len(world.garrisons._by_sector)
        world.garrisons._by_sector.clear()
        logger.info(f"Cleared {cleared_garrisons} garrison entries")

    # Clear knowledge manager cache
    cleared_cache = 0
    if hasattr(world, "knowledge_manager") and world.knowledge_manager:
        cleared_cache = len(world.knowledge_manager.cache)
        world.knowledge_manager.cache.clear()
        logger.info(f"Cleared {cleared_cache} knowledge cache entries")

    # Optionally clear test files from disk
    deleted_files = 0
    if clear_files:
        # Get the configured world-data directory
        world_data_dir = get_world_data_path()
        knowledge_dir = world_data_dir / "character-map-knowledge"

        if knowledge_dir.exists():
            for json_file in knowledge_dir.glob("*.json"):
                # Check if filename starts with any of the test prefixes
                if any(prefix in json_file.name for prefix in file_prefixes):
                    json_file.unlink()
                    deleted_files += 1
            logger.info(f"Deleted {deleted_files} test character files")

        # Reset garrison file
        garrison_file = world_data_dir / "sector_garrisons.json"
        if garrison_file.exists():
            with open(garrison_file, "w") as f:
                json.dump({"meta": {"version": 1}, "sectors": []}, f, indent=2)
            logger.info("Reset garrison file")

        # Reset ports to initial universe state (deletes files, clears cache, reloads from universe data)
        ports_reset = 0
        if hasattr(world, "port_manager") and world.port_manager:
            ports_reset = world.port_manager.reset_all_ports()
            logger.info(f"Reset {ports_reset} ports to initial state")

        # Truncate event log
        event_log = world_data_dir / "event-log.jsonl"
        if event_log.exists():
            event_log.write_text("")
            logger.info("Truncated event-log.jsonl")

        # Clear corporation files and registry for deterministic corp tests
        corps_dir = world_data_dir / "corporations"
        if corps_dir.exists():
            for corp_file in corps_dir.glob("*.json"):
                corp_file.unlink()
        registry_path = world_data_dir / "corporation_registry.json"
        registry_payload = {"by_name": {}}
        registry_path.write_text(json.dumps(registry_payload, indent=2))
        logger.info("Reset corporation registry and cleared corp files")

    return {
        "cleared_characters": cleared_characters,
        "cleared_combats": cleared_combats,
        "cleared_salvage": cleared_salvage,
        "cleared_garrisons": cleared_garrisons,
        "cleared_cache": cleared_cache,
        "deleted_files": deleted_files,
        "ports_reset": ports_reset if clear_files else 0,
    }
