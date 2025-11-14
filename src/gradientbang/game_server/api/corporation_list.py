from __future__ import annotations

from gradientbang.game_server.api.utils import rpc_success


async def handle(request: dict, world) -> dict:  # noqa: ARG001 - request unused
    corps = world.corporation_manager.list_all()
    corps.sort(key=lambda entry: entry.get("member_count", 0), reverse=True)
    return rpc_success({"corporations": corps})
