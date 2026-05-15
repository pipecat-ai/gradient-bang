"""Tests for ``make_event_adapter`` env-driven event transport selection."""

import pytest

from gradientbang.adapters.events import make_event_adapter
from gradientbang.adapters.events.polling import PollingEventAdapter
from gradientbang.adapters.events.pubsub import PubsubEventAdapter
from gradientbang.utils.supabase_client import AsyncGameClient


PLAYER_ID = "11111111-1111-1111-1111-111111111111"


@pytest.fixture
def client() -> AsyncGameClient:
    return AsyncGameClient(
        base_url="http://localhost:54321/functions/v1",
        character_id=PLAYER_ID,
        enable_event_polling=False,
    )


@pytest.mark.unit
class TestMakeEventAdapter:
    def test_unset_env_returns_polling_adapter(self, monkeypatch, client):
        monkeypatch.delenv("EVENT_TRANSPORT", raising=False)
        assert isinstance(make_event_adapter(client), PollingEventAdapter)

    def test_explicit_polling_returns_polling_adapter(self, monkeypatch, client):
        monkeypatch.setenv("EVENT_TRANSPORT", "polling")
        assert isinstance(make_event_adapter(client), PollingEventAdapter)

    def test_explicit_pubsub_returns_pubsub_adapter(self, monkeypatch, client):
        monkeypatch.setenv("EVENT_TRANSPORT", "pubsub")
        assert isinstance(make_event_adapter(client), PubsubEventAdapter)

    def test_transport_value_is_case_insensitive_and_trimmed(self, monkeypatch, client):
        monkeypatch.setenv("EVENT_TRANSPORT", "  POLLING  ")
        assert isinstance(make_event_adapter(client), PollingEventAdapter)

    def test_invalid_transport_raises_with_helpful_message(self, monkeypatch, client):
        monkeypatch.setenv("EVENT_TRANSPORT", "realtime")
        with pytest.raises(ValueError, match="realtime"):
            make_event_adapter(client)
