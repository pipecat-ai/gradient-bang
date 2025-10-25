"""
Character registration helper for test suite.

This module provides utilities for registering test characters to prevent
"Character is not registered" errors during integration tests.
"""

import json
from pathlib import Path
from typing import Dict, Any


# All test character IDs found in integration tests
TEST_CHARACTER_IDS = [
    "push_player",
    "test_2p_player1",
    "test_2p_player2",
    "test_3p_player1",
    "test_3p_player2",
    "test_abf_attacker",
    "test_abf_defender",
    "test_char_2",
    "test_char_events",
    "test_clean1",
    "test_clean2",
    "test_client_char",
    "test_conc1a",
    "test_conc1b",
    "test_conc2a",
    "test_conc2b",
    "test_def_deployer",
    "test_def_victim",
    "test_dest_attacker",
    "test_dest_victim",
    "test_disc1",
    "test_disc2",
    "test_dmg_attacker",
    "test_dmg_defender",
    "test_end_combatant1",
    "test_end_combatant2",
    "test_end_observer",
    "test_fail_chaser",
    "test_fail_runner",
    "test_filt_observer",
    "test_filt_player1",
    "test_filt_player2",
    "test_flee_chaser",
    "test_flee_runner",
    "test_garrison_target",
    "test_gow_enemy",
    "test_gow_owner",
    "test_gwo_deployer",
    "test_gwo_victim",
    "test_hit_attacker",
    "test_hit_defender",
    "test_inv_attacker",
    "test_inv_victim",
    "test_launch1",
    "test_launch2",
    "test_multi_strong",
    "test_multi_weak",
    "test_off_deployer",
    "test_off_victim",
    "test_opponent",
    "test_opponent2",
    "test_opponent3",
    "test_pod_strong",
    "test_pod_weak",
    "test_prob_chaser",
    "test_prob_runner",
    "test_salv_attacker",
    "test_salv_loser",
    "test_salv_observer",
    "test_salv_victim",
    "test_salv_winner",
    "test_shield1",
    "test_shield2",
    "test_state1",
    "test_state2",
    "test_submit1",
    "test_submit2",
    "test_summary1",
    "test_summary2",
    "test_timeout1",
    "test_timeout2",
    "test_toll_deployer",
    "test_toll_payer",
    "test_warp_chaser",
    "test_warp_runner",
    "test_weak_opponent",
    "test_win_loser",
    "test_win_winner",
    "ws_player",
]


def register_all_test_characters(world_data_dir: str = "tests/test-world-data") -> None:
    """
    Register all test characters in the characters.json file.

    This function writes all test character IDs to the characters registry,
    preventing "Character is not registered" errors during tests.

    Args:
        world_data_dir: Path to the world data directory (default: tests/test-world-data)

    Note:
        - This should be called ONCE per pytest session (session-scoped fixture)
        - Characters are registered with no password (empty password_hash)
        - Email format: <character_id>@test.com
    """
    characters_file = Path(world_data_dir) / "characters.json"

    # Load existing characters file or create new structure
    if characters_file.exists():
        with open(characters_file, "r") as f:
            data = json.load(f)
    else:
        data = {
            "admin_password_plain": "",
            "password_hash": "",
            "characters": {}
        }

    # Add all test characters
    for character_id in TEST_CHARACTER_IDS:
        if character_id not in data["characters"]:
            data["characters"][character_id] = {
                "name": character_id,
                "email": f"{character_id}@test.com",
                "password_hash": ""
            }

    # Write back to file
    characters_file.parent.mkdir(parents=True, exist_ok=True)
    with open(characters_file, "w") as f:
        json.dump(data, f, indent=2)


def get_registered_characters(world_data_dir: str = "tests/test-world-data") -> Dict[str, Any]:
    """
    Get all registered characters from the characters.json file.

    Args:
        world_data_dir: Path to the world data directory

    Returns:
        Dictionary of registered characters
    """
    characters_file = Path(world_data_dir) / "characters.json"

    if not characters_file.exists():
        return {}

    with open(characters_file, "r") as f:
        data = json.load(f)

    return data.get("characters", {})


def is_character_registered(character_id: str, world_data_dir: str = "tests/test-world-data") -> bool:
    """
    Check if a character is registered.

    Args:
        character_id: The character ID to check
        world_data_dir: Path to the world data directory

    Returns:
        True if character is registered, False otherwise
    """
    characters = get_registered_characters(world_data_dir)
    return character_id in characters
