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
    "test_3p_player3",
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
    # Concurrency test characters (test_concurrency.py)
    "test_concurrent_1",
    "test_concurrent_2",
    "test_lock_char",
    "test_port_trader_1",
    "test_port_trader_2",
    "test_port_trader_3",
    "test_credit_lock_1",
    "test_credit_lock_2",
    "test_combat_lock_p1",
    "test_combat_lock_p2",
    "test_race_move",
    "test_race_spend",
    "test_race_trade",
    "test_lock_timeout",
    "test_lock_char_a",
    "test_lock_char_b",
    "test_port_corruption_1",
    "test_port_corruption_2",
    "test_port_ind_1",
    "test_port_ind_2",
    "test_port_release",
    "test_port_timeout",
    "test_credit_atomic",
    "test_credit_combo",
    "test_credit_fail",
    "test_credit_ind_a",
    "test_credit_ind_b",
    "test_credit_transfer_1",
    "test_credit_transfer_2",
    "test_combat_atomic_1",
    "test_combat_atomic_2",
    "test_combat_double_1",
    "test_combat_double_2",
    "test_combat_release_1",
    "test_combat_release_2",
    "test_race_garrison_1",
    "test_race_garrison_2",
    "test_stress_rapid",
    # Combat zone restriction test characters (test_combat_system.py)
    "test_combat_zone_fighter1",
    "test_combat_zone_fighter2",
    "test_combat_zone_arrival",
    "test_join_zone_fighter1",
    "test_join_zone_fighter2",
    "test_join_zone_arrival",
    "test_join_existing_fighter1",
    "test_join_existing_fighter2",
    "test_join_existing_arrival",
    "test_ended_fighter1",
    "test_ended_fighter2",
    "test_ended_arrival",
    # Phase 2 test characters (test_event_system.py, test_movement_system.py, test_trading_system.py)
    "test_event_character",
    "test_join_event",
    "test_movement_player1",
    "test_movement_player2",
    "test_movement_low_warp",
    "test_generic_client",
    "test_trader_at_port",
    "test_trader_with_cargo",
    "test_trader_no_port",
    "test_rich_trader",
    "test_hyperspace_trader",
    # Stress test characters (dynamically created)
    # Note: Stress tests create 100s of characters with pattern test_stress_*
    # We register a few representative ones here
    "test_stress_move_0",
    "test_stress_move_1",
    "test_stress_trade_0",
    "test_stress_trade_1",
    "test_stress_combat_0",
    "test_stress_combat_1",
    "test_stress_corruption_0",
    "test_stress_corruption_1",
    # Persistence test characters (test_persistence.py)
    "test_persistence_client",
    "test_persistence_char1",
    "test_persistence_multi1",
    "test_persistence_multi2",
    "test_persistence_attacker",
    "test_persistence_defender",
    "test_persistence_garrison2",
    "test_persistence_garrison_owner",
    "test_persistence_newcomer",
    "test_persistence_flee_attacker",
    "test_persistence_flee_defender",
    "test_persistence_flee_attacker2",
    "test_persistence_flee_defender2",
    "test_reset_runner",
    # Cache coherence test characters (test_persistence.py Phase 3.5)
    "test_cache_coherence_1",
    "test_cache_coherence_2",
    "test_cache_coherence_3",
    "test_cache_coherence_4",
    "test_cache_coherence_5",
    # Crash recovery test characters (test_persistence.py Phase 3.5)
    "test_crash_recovery_1",
    "test_crash_recovery_2",
    "test_crash_recovery_3a",
    "test_crash_recovery_3b",
    "test_crash_recovery_4",
    # Supabase schema validation test characters (test_persistence.py Phase 3.5)
    "test_supabase_schema_1",
    "test_supabase_schema_2",
    "test_supabase_schema_3",
    "test_supabase_schema_5",
    # Trading system test characters
    "test_trading_client",
    "test_concurrent_trader1",
    "test_concurrent_trader2",
    "test_hyperspace_trader",
    "test_trader_no_port",
    # Event system test characters
    "test_concurrent_event1",
    "test_concurrent_event2",
    "test_public_event1",
    "test_public_event2",
    # JSONL audit log test characters (TestJSONLAuditLog)
    "test_jsonl_logging",
    "test_jsonl_format",
    "test_jsonl_parseable",
    "test_jsonl_append",
    # Admin query mode test characters (TestAdminQueryMode)
    "test_admin_query_char1",
    "test_admin_query_char2",
    "test_admin_filter_char1",
    "test_admin_filter_char2",
    "test_admin_sector_filter",
    "test_admin_combined",
    "test_admin_invalid",
    # Character query mode test characters (TestCharacterQueryMode)
    "test_char_query_own",
    "test_char_privacy1",
    "test_char_privacy2",
    "test_char_sector_filter",
    "test_char_empty_sector",
    "test_char_requires_id",
    # Multi-character fan-out test characters (TestMultiCharacterEventFanout)
    "test_fanout_player1",
    "test_fanout_player2",
    "test_fanout_player3",
    # Phase 4: AsyncGameClient test characters (test_async_game_client.py)
    "test_client_connect",
    "test_client_cleanup",
    "test_cache_hit",
    "test_cache_move",
    "test_cache_status",
    "test_cache_visited",
    "test_cache_join",
    "test_join_create",
    "test_move_adjacent",
    "test_plot_course",
    "test_trade_buy",
    "test_trade_sell",
    "test_combat_attacker",
    "test_combat_defender",
    "test_action_attacker",
    "test_action_defender",
    "test_recharge",
    "test_transfer_from",
    "test_transfer_to",
    "test_my_status",
    "test_network_error",
    "test_timeout",
    "test_server_error",
    "test_invalid_endpoint",
    "test_bad_params",
    "test_conn_refused",
    "test_default_char",
    "test_bound_char",
    "test_multi_char1",
    "test_multi_char2",
    "test_mismatch",
    "test_req_char_id",
    "test_ctx_enter",
    "test_ctx_exit",
    "test_ctx_exception",
    # Phase 4: Game Server API test characters (test_game_server_api.py)
    "test_api_join",
    "test_api_status",
    "test_api_move",
    "test_api_move_invalid",
    "test_api_move_hyperspace",
    "test_api_plot",
    "test_api_local_map",
    "test_api_list_ports",
    "test_api_path_region",
    "test_api_trade_buy",
    "test_api_trade_sell",
    "test_api_trade_fail",
    "test_api_combat_att",
    "test_api_combat_def",
    "test_api_flee_att",
    "test_api_flee_def",
    "test_api_garrison",
    "test_api_recharge",
    "test_api_xfer_from",
    "test_api_xfer_to",
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

    # Add all test characters from the list
    for character_id in TEST_CHARACTER_IDS:
        if character_id not in data["characters"]:
            data["characters"][character_id] = {
                "name": character_id,
                "email": f"{character_id}@test.com",
                "password_hash": ""
            }

    # Add stress test characters (ranges)
    # These are created dynamically by stress tests
    stress_patterns = [
        ("test_stress_move_", 50),      # test_50_concurrent_moves
        ("test_stress_trade_", 50),     # test_50_concurrent_trades_at_same_port
        ("test_stress_combat_", 20),    # test_10_concurrent_combat_sessions (20 chars, 10 pairs)
        ("test_stress_mixed_", 50),     # test_concurrent_mixed_operations
        ("test_stress_rapid_", 5),      # Additional stress test chars
    ]

    for prefix, count in stress_patterns:
        for i in range(count):
            character_id = f"{prefix}{i}"
            if character_id not in data["characters"]:
                data["characters"][character_id] = {
                    "name": character_id,
                    "email": f"{character_id}@test.com",
                    "password_hash": ""
                }

    # Add event system test characters that create multiple chars dynamically
    for i in range(10):  # Support up to 10 dynamic event test characters
        character_id = f"test_event_char_{i}"
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
