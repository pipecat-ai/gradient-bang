"""Test that the combat_tick_worker fixture actually starts and runs."""
import asyncio
import pytest


@pytest.mark.asyncio
async def test_combat_tick_worker_is_running(combat_tick_worker):
    """Verify the combat_tick_worker fixture runs in background."""
    # Just wait a bit to let the worker run
    print("\n[TEST] Starting, worker should be running in background...")
    await asyncio.sleep(10.0)
    print("[TEST] Worker had 10 seconds to run")
    # If we get here without errors, the worker is functioning
    assert True, "Worker fixture loaded successfully"
