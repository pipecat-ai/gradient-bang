"""Unit tests for the NPC TaskAgent CLI."""

from __future__ import annotations

import sys

from npc import run_npc


def test_parse_args_supports_ship_id(monkeypatch):
    """Ensure corporation ship control flag is accepted by the CLI."""

    monkeypatch.setenv("GOOGLE_API_KEY", "test-key")
    argv = [
        "run_npc.py",
        "actor-123",
        "--ship-id",
        "ship-abc",
        "Scout sector 7",
    ]
    monkeypatch.setattr(sys, "argv", argv)

    args = run_npc.parse_args()

    assert args.actor_id == "actor-123"
    assert args.ship_id == "ship-abc"
    assert args.task == "Scout sector 7"
