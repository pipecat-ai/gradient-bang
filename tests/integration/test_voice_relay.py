"""Full integration tests: EventRelay + VoiceAgent with real DB fixtures.

Requires a running Supabase instance with edge functions (server.ts).
Run via: bash scripts/run-integration-tests.sh

Uses the E2EHarness with real AsyncQueueBus, real AgentRunner, and real
AsyncGameClient. Tests feed events from the real DB through the relay pipeline.
"""

import pytest

from gradientbang.utils.legacy_ids import canonicalize_character_id

from .e2e_harness import (
    E2EHarness,
    EdgeAPI,
    get_ship_id,
    seed_mega_port_at_sector_0,
    set_ship_sector,
)

# Edge function cold starts can be slow
pytestmark = pytest.mark.timeout(120)


# ── Fixtures ──────────────────────────────────────────────────────────────


@pytest.fixture
async def edge_api(supabase_url, supabase_service_role_key):
    api = EdgeAPI(supabase_url, supabase_service_role_key)
    yield api
    await api.close()


# ── Onboarding ────────────────────────────────────────────────────────────


@pytest.mark.integration
class TestOnboardingNewPlayer:
    """New character with no megaport knowledge gets the onboarding prompt."""

    @pytest.fixture(autouse=True)
    async def setup(self, reset_db_with_characters, edge_api, make_game_client):
        await reset_db_with_characters(["test_relay_new"])
        self.character_id = canonicalize_character_id("test_relay_new")
        self.api = edge_api
        self.make_game_client = make_game_client

    async def test_new_player_onboarding_flow(self):
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()

            # New player detected (no megaports known)
            assert h.relay.is_new_player is True

            # Onboarding prompt injected into LLM context
            assert h.relay._onboarding_complete is True
            onboarding = [c for c, _ in h.llm_messages if '<event name="onboarding">' in c]
            assert len(onboarding) == 1, (
                f"Expected 1 onboarding frame, got {len(onboarding)}. "
                f"All frames: {[c[:80] for c, _ in h.llm_messages]}"
            )

            # Status snapshot also delivered
            status = [c for c, _ in h.llm_messages if "status.snapshot" in c]
            assert len(status) >= 1

            # RTVI got pushes
            assert h.rtvi_push_count > 0

            # Bus got broadcasts
            assert len(h.bus_events) > 0
        finally:
            await h.stop()


@pytest.mark.integration
class TestOnboardingVeteranPlayer:
    """Returning player who has discovered a mega-port gets session.start."""

    @pytest.fixture(autouse=True)
    async def setup(self, reset_db_with_characters, edge_api, supabase_url, supabase_service_role_key, make_game_client):
        await reset_db_with_characters(["test_relay_vet"])
        self.character_id = canonicalize_character_id("test_relay_vet")
        self.api = edge_api
        self.make_game_client = make_game_client

        await seed_mega_port_at_sector_0(supabase_url, supabase_service_role_key)

        ship_id = await get_ship_id(supabase_url, supabase_service_role_key, self.character_id)
        await set_ship_sector(supabase_url, supabase_service_role_key, ship_id, 0)

    async def test_veteran_gets_session_start(self):
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()

            assert h.relay.is_new_player is False, (
                f"Expected veteran. Ports frames: "
                f"{[c[:100] for c, _ in h.llm_messages if 'ports.list' in c]}"
            )
            assert h.relay._onboarding_complete is True

            session = [c for c, _ in h.llm_messages if '<event name="session.start">' in c]
            assert len(session) == 1, (
                f"Expected 1 session.start frame. All: {[c[:80] for c, _ in h.llm_messages]}"
            )

            onboarding = [c for c, _ in h.llm_messages if '<event name="onboarding">' in c]
            assert len(onboarding) == 0
        finally:
            await h.stop()


# ── Megaport Discovery ────────────────────────────────────────────────────


@pytest.mark.integration
class TestMegaportDiscoveryAtRuntime:
    """New player starts away from mega-port, moves there, discovers it."""

    @pytest.fixture(autouse=True)
    async def setup(self, reset_db_with_characters, edge_api, supabase_url, supabase_service_role_key, make_game_client):
        await reset_db_with_characters(["test_relay_discover"])
        self.character_id = canonicalize_character_id("test_relay_discover")
        self.api = edge_api
        self.make_game_client = make_game_client
        self.supabase_url = supabase_url
        self.service_key = supabase_service_role_key

        await seed_mega_port_at_sector_0(supabase_url, supabase_service_role_key)

        self.ship_id = await get_ship_id(supabase_url, supabase_service_role_key, self.character_id)
        await set_ship_sector(supabase_url, supabase_service_role_key, self.ship_id, 1)

    async def test_new_player_discovers_megaport_becomes_veteran(self):
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()
            assert h.relay.is_new_player is True
            assert h.relay._onboarding_complete is True

            # Clear frames to isolate discovery
            h.llm_frames.clear()
            h.bus_events.clear()

            # Move ship to sector 0 (mega-port) and re-join
            await set_ship_sector(self.supabase_url, self.service_key, self.ship_id, 0)

            cursor = h._event_cursor
            await self.api.call_ok("join", {"character_id": self.character_id})
            await self.api.call_ok(
                "list_known_ports",
                {"character_id": self.character_id, "mega": True, "max_hops": 100},
            )

            # Fetch and feed all new events
            await h.poll_and_feed_events()

            assert h.relay.is_new_player is False, (
                f"Expected veteran after megaport discovery. "
                f"Ports frames: {[c[:100] for c, _ in h.llm_messages if 'ports.list' in c]}"
            )
        finally:
            await h.stop()


# ── Event Flow ────────────────────────────────────────────────────────────


@pytest.mark.integration
class TestJoinEventFlow:
    """Verify the complete event flow during join."""

    @pytest.fixture(autouse=True)
    async def setup(self, reset_db_with_characters, edge_api, make_game_client):
        await reset_db_with_characters(["test_relay_flow"])
        self.character_id = canonicalize_character_id("test_relay_flow")
        self.api = edge_api
        self.make_game_client = make_game_client

    async def test_join_delivers_status_and_events(self):
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()
            assert len(h.llm_messages) > 0, "No LLM frames received after join"
            status = [c for c, _ in h.llm_messages if "status.snapshot" in c]
            assert len(status) >= 1
        finally:
            await h.stop()

    async def test_rtvi_always_receives_events(self):
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()
            assert h.rtvi_push_count > 0
        finally:
            await h.stop()

    async def test_bus_always_receives_events(self):
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()
            assert len(h.bus_events) > 0
            for event in h.bus_events:
                assert "event_name" in event
        finally:
            await h.stop()
