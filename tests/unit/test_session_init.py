import pytest

from gradientbang.runtime.session_init import gather_initial_state

pytestmark = pytest.mark.unit


class _FakeGameClient:
    def __init__(self, *, ports: list[dict] | None, onboarding_route=None) -> None:
        self.ports = ports
        self.onboarding_route = onboarding_route if onboarding_route is not None else [7, 8, 9]

    async def join(self, character_id: str) -> dict:
        return {
            "is_first_visit": False,
            "status": {
                "player": {
                    "name": "Captain Unit",
                    "universe_size": 1000,
                    "fedspace_sector_count": 50,
                }
            },
            "map_local": {"sector": {"id": 7}},
            "onboarding_route": self.onboarding_route,
        }

    async def list_user_ships(self, *, character_id: str) -> dict:
        return {"ships": [{"ship_id": "ship-1"}]}

    async def quest_status(self, *, character_id: str) -> dict:
        return {"quests": []}

    async def list_known_ports(self, *, character_id: str, mega: bool, max_hops: int) -> dict:
        return {"ports": self.ports}

    def _get_summary(self, event_name: str, payload: dict) -> str:
        return f"{event_name} summary"


async def _initial_messages(
    *,
    ports: list[dict] | None,
    new_player_onboarding_enabled: bool = True,
    onboarding_route=None,
) -> list[dict]:
    state = await gather_initial_state(
        game_client=_FakeGameClient(ports=ports, onboarding_route=onboarding_route),
        character_id="character-id",
        character_display_name="Fallback Name",
        new_player_onboarding_enabled=new_player_onboarding_enabled,
    )
    return state.initial_messages


@pytest.mark.asyncio
async def test_new_player_onboarding_includes_hidden_megaport_route() -> None:
    messages = await _initial_messages(ports=[])
    final_message = messages[-1]["content"]

    assert '<event name="onboarding">' in final_message
    assert "Route to nearest mega-port: 7 \u2192 8 \u2192 9" in final_message
    assert '<event name="session.start"></event>' not in final_message


@pytest.mark.asyncio
async def test_new_player_onboarding_can_be_disabled_for_evals() -> None:
    messages = await _initial_messages(ports=[], new_player_onboarding_enabled=False)
    final_message = messages[-1]["content"]

    assert final_message == '<event name="session.start"></event>'
    assert '<event name="onboarding">' not in final_message
    assert "Route to nearest mega-port" not in final_message


@pytest.mark.asyncio
async def test_known_megaport_skips_new_player_onboarding() -> None:
    messages = await _initial_messages(ports=[{"sector": 42, "mega": True}])
    final_message = messages[-1]["content"]

    assert final_message == '<event name="session.start"></event>'
    assert '<event name="onboarding">' not in final_message


@pytest.mark.asyncio
async def test_new_player_onboarding_handles_missing_route() -> None:
    messages = await _initial_messages(ports=[], onboarding_route=["bad", "route"])
    final_message = messages[-1]["content"]

    assert '<event name="onboarding">' in final_message
    assert "Route to nearest mega-port: unavailable" in final_message
