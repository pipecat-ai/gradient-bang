#!/usr/bin/env python3
"""Spawn an NPC on Modal (fire-and-forget).

Usage:
    python spawn_npc.py npc-01
    python spawn_npc.py npc-01 --fragment aggressive
    python spawn_npc.py npc-01 npc-02 npc-03
    python spawn_npc.py npc-01 npc-02 --fragment friendly
"""

import argparse
import modal


def main():
    parser = argparse.ArgumentParser(description="Spawn NPC agents on Modal")
    parser.add_argument(
        "character_ids",
        nargs="+",
        help="One or more character IDs to spawn",
    )
    parser.add_argument(
        "--fragment",
        default=None,
        help="Personality fragment (e.g. aggressive, friendly). Random if omitted.",
    )
    args = parser.parse_args()

    NPC = modal.Cls.from_name("gb-npc", "NPC")

    for character_id in args.character_ids:
        frag_label = args.fragment or "random"
        print(f"Spawning {character_id} (fragment={frag_label}) ...")
        NPC().run.spawn(character_id=character_id, fragment=args.fragment)

    print(f"Spawned {len(args.character_ids)} NPC(s).")


if __name__ == "__main__":
    main()
