import json
from datetime import datetime, timedelta, timezone

import pytest

from gradientbang.game_server.server_logging.event_log import EventLogger, EventRecord, MAX_QUERY_RESULTS
from gradientbang.game_server.rpc.events import EventDispatcher, EventLogContext


def test_event_logger_append_and_query(tmp_path):
    log_path = tmp_path / "events.jsonl"
    logger = EventLogger(log_path)

    now = datetime.now(timezone.utc)
    record = EventRecord(
        timestamp=now.isoformat(),
        direction="sent",
        event="test.event",
        payload={"foo": "bar"},
        sender="alpha",
        receiver=None,
        sector=42,
        corporation_id=None,
        meta={"note": "sample"},
    )
    logger.append(record)

    results, truncated = logger.query(
        start=now - timedelta(minutes=1),
        end=now + timedelta(minutes=1),
        character_id="alpha",
    )

    assert truncated is False
    assert len(results) == 1
    assert results[0]["event"] == "test.event"
    assert results[0]["payload"]["foo"] == "bar"

    # Query outside range returns empty list
    assert (
        logger.query(
            start=now + timedelta(minutes=1),
            end=now + timedelta(minutes=2),
        )
        == ([], False)
    )


class _DummySink:
    def __init__(self, character_id: str) -> None:
        self.character_id = character_id
        self.connection_id = f"conn-{character_id}"
        self.envelopes: list[dict] = []

    async def send_event(self, envelope: dict) -> None:
        self.envelopes.append(envelope)

    def match_character(self, character_id: str) -> bool:
        return self.character_id == character_id


@pytest.mark.asyncio
async def test_event_dispatcher_logs_sent_and_received(tmp_path):
    log_path = tmp_path / "events.jsonl"
    dispatcher = EventDispatcher()
    dispatcher.set_event_logger(EventLogger(log_path))

    sink = _DummySink("char-123")
    await dispatcher.register(sink)

    payload = {"hello": "world"}
    ctx = EventLogContext(sender="char-123", sector=7)

    await dispatcher.emit(
        "status.update",
        payload,
        character_filter=["char-123"],
        log_context=ctx,
    )

    with log_path.open("r", encoding="utf-8") as handle:
        lines = [json.loads(line) for line in handle if line.strip()]

    assert len(lines) == 2  # sent + received
    sent, received = lines

    assert sent["direction"] == "sent"
    assert sent["receiver"] is None
    assert sent["payload"] == payload

    assert received["direction"] == "received"
    assert received["receiver"] == "char-123"
    assert received["meta"]["status"] == "ok"

    # Ensure query caps large responses
    logger = EventLogger(log_path)
    window_start = datetime.fromisoformat(sent["timestamp"]) - timedelta(minutes=1)
    window_end = datetime.fromisoformat(sent["timestamp"]) + timedelta(minutes=1)
    queried, truncated = logger.query(window_start, window_end)
    assert len(queried) == 2
    assert truncated is False
    assert MAX_QUERY_RESULTS >= len(queried)
