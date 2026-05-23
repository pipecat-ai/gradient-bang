from __future__ import annotations

import pytest

from gradientbang.adapters.events.factory import make_event_adapter
from gradientbang.adapters.events.polling import PollingEventAdapter
from gradientbang.adapters.events.pubsub import PubsubEventAdapter
from gradientbang.utils.supabase_client import AsyncGameClient


PLAYER_ID = "11111111-1111-1111-1111-111111111111"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> AsyncGameClient:
    monkeypatch.setenv("SUPABASE_URL", "http://localhost:54321")
    return AsyncGameClient(character_id=PLAYER_ID, enable_event_polling=False)


def test_unset_event_transport_defaults_to_session_pubsub(
    client: AsyncGameClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("EVENT_TRANSPORT", raising=False)

    assert isinstance(make_event_adapter(client), PubsubEventAdapter)


def test_polling_transport_still_available(
    client: AsyncGameClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("EVENT_TRANSPORT", "polling")

    assert isinstance(make_event_adapter(client), PollingEventAdapter)


def test_invalid_transport_raises(
    client: AsyncGameClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("EVENT_TRANSPORT", "invalid")

    with pytest.raises(ValueError, match="unknown EVENT_TRANSPORT"):
        make_event_adapter(client)
