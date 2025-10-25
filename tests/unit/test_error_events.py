from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from api.utils import emit_error_event


@pytest.mark.asyncio
async def test_emit_error_event_dispatches_with_source_metadata():
    dispatcher = SimpleNamespace()
    dispatcher.emit = AsyncMock()

    await emit_error_event(
        dispatcher,
        character_id="char1",
        endpoint="move",
        request_id="req-error",
        error="Invalid move",
    )

    dispatcher.emit.assert_awaited_once()
    call_args = dispatcher.emit.call_args

    event_name, payload = call_args.args[:2]
    assert event_name == "error"
    assert payload["endpoint"] == "move"
    assert payload["error"] == "Invalid move"

    source = payload["source"]
    assert source["type"] == "rpc"
    assert source["method"] == "move"
    assert source["request_id"] == "req-error"
    assert isinstance(source["timestamp"], str)

    assert call_args.kwargs["character_filter"] == ["char1"]
    log_context = call_args.kwargs.get("log_context")
    assert log_context is not None
    assert log_context.sender == "char1"
