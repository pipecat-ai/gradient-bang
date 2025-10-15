from datetime import datetime, timezone

from api.utils import build_event_source, rpc_failure, rpc_success


def test_rpc_success_minimal():
    result = rpc_success()
    assert result == {"success": True}


def test_rpc_success_with_data():
    result = rpc_success({"combat_id": "test-123"})
    assert result == {"success": True, "combat_id": "test-123"}


def test_rpc_failure():
    result = rpc_failure("Invalid sector")
    assert result == {"success": False, "error": "Invalid sector"}


def test_build_event_source_with_timestamp():
    timestamp = datetime(2025, 10, 15, 12, 30, tzinfo=timezone.utc)
    result = build_event_source(
        "move",
        "abc123",
        source_type="rpc",
        timestamp=timestamp,
    )
    assert result == {
        "type": "rpc",
        "method": "move",
        "request_id": "abc123",
        "timestamp": timestamp.isoformat(),
    }
