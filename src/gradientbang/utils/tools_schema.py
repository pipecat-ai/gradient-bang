# tools_schema.py

from abc import ABC
from typing import Any, Dict, List, Optional
import re

from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.services.open_ai_adapter import OpenAILLMAdapter

from gradientbang.utils.supabase_client import AsyncGameClient

from openai.types.chat import ChatCompletionToolParam


_ID_PREFIX_LEN = 6
_UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{12}"
)
_BRACKET_HEX_RE = re.compile(r"\[([0-9a-fA-F]{8,})\]")


def _short_id(value: Any, prefix_len: int = _ID_PREFIX_LEN) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    return text[:prefix_len]


def _shorten_embedded_ids(text: str, prefix_len: int = _ID_PREFIX_LEN) -> str:
    if not isinstance(text, str) or not text:
        return text
    text = _UUID_RE.sub(lambda match: match.group(0)[:prefix_len], text)
    text = _BRACKET_HEX_RE.sub(lambda match: f"[{match.group(1)[:prefix_len]}]", text)
    return text


def _friendly_ship_type(raw_type: Optional[str]) -> str:
    if not isinstance(raw_type, str) or not raw_type:
        return "unknown"
    return raw_type.replace("_", " ").title()


def _format_ship_holds(ship: Dict[str, Any]) -> str:
    cargo = ship.get("cargo") if isinstance(ship, dict) else None
    capacity = ship.get("cargo_capacity")
    used = 0
    if isinstance(cargo, dict):
        for value in cargo.values():
            if isinstance(value, (int, float)):
                used += int(value)
    if isinstance(capacity, (int, float)):
        empty = max(int(capacity) - used, 0)
        return f"holds {int(capacity)} (empty {empty})"
    return "holds ?"


def _summarize_corporation_info(result: Any) -> str:
    if not isinstance(result, dict):
        return "Corporation info unavailable."

    corporations = result.get("corporations")
    if isinstance(corporations, list):
        count = len(corporations)
        if count == 0:
            return "No corporations found."
        entries: List[str] = []
        for corp in corporations[:5]:
            if not isinstance(corp, dict):
                continue
            name = _shorten_embedded_ids(str(corp.get("name", "Unknown")))
            member_count = corp.get("member_count")
            if isinstance(member_count, int):
                entries.append(f"{name} ({member_count})")
            else:
                entries.append(name)
        summary = f"Corporations: {count} total. " + ", ".join(entries)
        remaining = count - len(entries)
        if remaining > 0:
            summary += f", +{remaining} more"
        return summary

    corp = result.get("corporation")
    if corp is None and any(
        key in result for key in ("corp_id", "name", "member_count", "members", "ships")
    ):
        corp = result
    if corp is None:
        return "You are not in a corporation."
    if not isinstance(corp, dict):
        return "Corporation info unavailable."

    corp_name = _shorten_embedded_ids(str(corp.get("name", "Unknown corporation")))
    ships = corp.get("ships") if isinstance(corp.get("ships"), list) else []
    ship_count = len(ships)
    member_count = corp.get("member_count")
    header = f"Corporation: {corp_name}"
    if isinstance(member_count, int):
        header += f" (members: {member_count}, ships: {ship_count})"
    else:
        header += f" (ships: {ship_count})"
    lines = [header]

    members = corp.get("members")
    if isinstance(members, list) and members:
        names: List[str] = []
        for member in members:
            if not isinstance(member, dict):
                continue
            name = member.get("name") or member.get("character_id")
            if isinstance(name, str) and name:
                names.append(_shorten_embedded_ids(name))
        if names:
            lines.append("Members: " + ", ".join(names))

    if ships:
        lines.append("Ships:")
        for ship in ships:
            if not isinstance(ship, dict):
                continue
            ship_name = ship.get("name") or ship.get("ship_name") or "Unnamed Vessel"
            ship_name = _shorten_embedded_ids(str(ship_name))
            ship_type = _friendly_ship_type(ship.get("ship_type"))
            ship_id_prefix = _short_id(ship.get("ship_id"))
            id_suffix = f" [{ship_id_prefix}]" if ship_id_prefix else ""
            sector = ship.get("sector")
            sector_display = sector if isinstance(sector, int) else "unknown"
            details: List[str] = [
                f"{ship_name}{id_suffix} ({ship_type}) in sector {sector_display}",
                _format_ship_holds(ship),
            ]
            warp = ship.get("warp_power")
            warp_max = ship.get("warp_power_capacity")
            if isinstance(warp, (int, float)) and isinstance(warp_max, (int, float)):
                details.append(f"warp {int(warp)}/{int(warp_max)}")
            credits = ship.get("credits")
            if isinstance(credits, (int, float)):
                details.append(f"credits {int(credits)}")
            current_task_id = ship.get("current_task_id")
            if isinstance(current_task_id, str) and current_task_id:
                task_display = _short_id(current_task_id) or current_task_id
            else:
                task_display = "none"
            details.append(f"task {task_display}")
            fighters = ship.get("fighters")
            if isinstance(fighters, (int, float)):
                details.append(f"fighters {int(fighters)}")
            lines.append("- " + "; ".join(details))
    else:
        lines.append("Ships: none")

    return "\n".join(lines)


def get_openai_tools_list(game_client, tools_classes) -> List[ChatCompletionToolParam]:
    adapter = OpenAILLMAdapter()
    ts = []
    for entry in tools_classes:
        tool_class = entry[0] if isinstance(entry, (tuple, list)) else entry
        ts.append(tool_class.schema())
    return adapter.to_provider_tools_format(ToolsSchema(ts))


class Tool(ABC):
    def __init__(self, **args):
        self.args = args

    # define a class method `schema` that all subclasses must override
    @classmethod
    def schema(cls):
        raise NotImplementedError


class GameClientTool:
    def __init__(self, game_client: AsyncGameClient):
        self.game_client = game_client


class MyStatus(GameClientTool):
    def __call__(self):
        return self.game_client.my_status(character_id=self.game_client.character_id)

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="my_status",
            description="Get your current status including current sector position",
            properties={},
            required=[],
        )


class LeaderboardResources(GameClientTool):
    def __call__(self, force_refresh: bool = False):
        return self.game_client.leaderboard_resources(
            character_id=self.game_client.character_id,
            force_refresh=force_refresh,
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="leaderboard_resources",
            description=(
                "Fetch the latest wealth leaderboard snapshot. The response "
                "includes players (with exploration percentage) and corporations, "
                "sorted by total resources."
            ),
            properties={},
            required=[],
        )


class MyMap(GameClientTool):
    def __call__(self):
        return self.game_client.my_map(character_id=self.game_client.character_id)

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="my_map",
            description="Get your map knowledge including all visited sectors, known ports, and discovered connections",
            properties={},
            required=[],
        )


class PlotCourse(GameClientTool):
    def __call__(self, to_sector):
        return self.game_client.plot_course(
            to_sector=to_sector, character_id=self.game_client.character_id
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="plot_course",
            description="Calculate shortest path from your current sector to the destination",
            properties={
                "to_sector": {
                    "type": "integer",
                    "description": "Destination sector ID",
                    "minimum": 0,
                },
            },
            required=["to_sector"],
        )


class LocalMapRegion(GameClientTool):
    def __call__(self, center_sector=None, max_hops=3, max_sectors=100):
        return self.game_client.local_map_region(
            character_id=self.game_client.character_id,
            center_sector=center_sector,
            max_hops=max_hops,
            max_sectors=max_sectors,
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="local_map_region",
            description="Get all known sectors around current location for local navigation and awareness. Shows visited sectors with full details (ports, adjacents, position) and nearby unvisited sectors seen in adjacency lists.",
            properties={
                "center_sector": {
                    "type": "integer",
                    "description": "Optional center sector; defaults to current sector",
                    "minimum": 0,
                },
                "max_hops": {
                    "type": "integer",
                    "description": "Maximum BFS depth (default 3, max 10)",
                    "minimum": 1,
                    "maximum": 10,
                    "default": 3,
                },
                "max_sectors": {
                    "type": "integer",
                    "description": "Maximum sectors to return (default 100)",
                    "minimum": 1,
                    "default": 100,
                },
            },
            required=[],
        )


class ListKnownPorts(GameClientTool):
    def __call__(
        self,
        from_sector=None,
        max_hops=5,
        port_type=None,
        commodity=None,
        trade_type=None,
        mega=None,
    ):
        return self.game_client.list_known_ports(
            character_id=self.game_client.character_id,
            from_sector=from_sector,
            max_hops=max_hops,
            port_type=port_type,
            commodity=commodity,
            trade_type=trade_type,
            mega=mega,
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="list_known_ports",
            description="Find all known ports within travel range for trading/planning. Useful for finding nearest port of specific type, mega-ports for services, or ports that buy/sell specific commodities.",
            properties={
                "from_sector": {
                    "type": "integer",
                    "description": "Optional starting sector; defaults to current sector",
                    "minimum": 0,
                },
                "max_hops": {
                    "type": "integer",
                    "description": "Maximum distance (default 5, max 100)",
                    "minimum": 1,
                    "maximum": 100,
                    "default": 5,
                },
                "port_type": {
                    "type": "string",
                    "description": "Optional filter by port code (e.g., 'BBB', 'SSS', 'BBS')",
                },
                "commodity": {
                    "type": "string",
                    "enum": ["quantum_foam", "retro_organics", "neuro_symbolics"],
                    "description": "Optional filter ports that trade this commodity",
                },
                "trade_type": {
                    "type": "string",
                    "enum": ["buy", "sell"],
                    "description": "Optional 'buy' or 'sell' (requires commodity). 'buy' finds ports that sell to you, 'sell' finds ports that buy from you.",
                },
                "mega": {
                    "type": "boolean",
                    "description": "Filter by mega-port status. Set true to find only mega-ports (warp recharge, banking, armory). Set false for regular ports only.",
                },
            },
            required=[],
        )


class PathWithRegion(GameClientTool):
    def __call__(self, to_sector, region_hops=1, max_sectors=200):
        return self.game_client.path_with_region(
            to_sector=to_sector,
            character_id=self.game_client.character_id,
            region_hops=region_hops,
            max_sectors=max_sectors,
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="path_with_region",
            description="Get path to destination plus local context around each path node for route visualization. Shows path, nearby known sectors, and identifies potential hazards or alternatives along the route.",
            properties={
                "to_sector": {
                    "type": "integer",
                    "description": "Destination sector ID",
                    "minimum": 0,
                },
                "region_hops": {
                    "type": "integer",
                    "description": "How many hops around each path node (default 1)",
                    "minimum": 0,
                    "maximum": 3,
                    "default": 1,
                },
                "max_sectors": {
                    "type": "integer",
                    "description": "Total sector limit (default 200)",
                    "minimum": 1,
                    "default": 200,
                },
            },
            required=["to_sector"],
        )


class Move(GameClientTool):
    def __call__(self, to_sector):
        return self.game_client.move(
            to_sector=to_sector, character_id=self.game_client.character_id
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="move",
            description="Move your ship to an adjacent sector. You can only move one sector at a time.",
            properties={
                "to_sector": {
                    "type": "integer",
                    "description": "Adjacent sector ID to move to",
                }
            },
            required=["to_sector"],
        )


class StartTask(GameClientTool):
    def __call__(self, task_description, context=None, ship_id=None):
        kwargs = {"task_description": task_description}
        if context:
            kwargs["context"] = context
        if ship_id:
            kwargs["ship_id"] = ship_id
        return self.game_client.start_task(**kwargs)

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="start_task",
            description=(
                "Start a complex multi-step task for navigation, trading, or exploration. "
                "Can control your own ship or a corporation ship."
            ),
            properties={
                "task_description": {
                    "type": "string",
                    "description": "Natural language description of the task to execute",
                },
                "context": {
                    "type": "string",
                    "description": "Relevant conversation history or clarifications",
                },
                "ship_id": {
                    "type": "string",
                    "description": (
                        "Corporation ship ID to control. Accepts a full UUID or the short "
                        "prefix shown in brackets (e.g., [5a8369]). Omit this parameter "
                        "to control your own ship instead."
                    ),
                },
            },
            required=["task_description"],
        )


class StopTask(GameClientTool):
    def __call__(self, task_id=None):
        kwargs = {}
        if task_id:
            kwargs["task_id"] = task_id
        return self.game_client.stop_task(**kwargs)

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="stop_task",
            description="Cancel a running task. If task_id is provided, cancels that specific task (full UUID or short prefix). Otherwise cancels your primary ship's task.",
            properties={
                "task_id": {
                    "type": "string",
                    "description": "Optional task ID to cancel a specific task (full UUID or short prefix, e.g., '8ea25c'). If not provided, cancels your primary ship's task.",
                },
            },
            required=[],
        )


class QueryTaskProgress(Tool):
    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="query_task_progress",
            description=(
                "Check on what a running or recently finished task is doing by querying its task log."
            ),
            properties={
                "task_id": {
                    "type": "string",
                    "description": (
                        "Optional task ID to query (short ID or full UUID). "
                        "If omitted, defaults to your primary ship's active task."
                    ),
                },
                "prompt": {
                    "type": "string",
                    "description": "Question or instruction about task progress.",
                },
            },
            required=["prompt"],
        )


class SteerTask(Tool):
    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="steer_task",
            description="Send a steering instruction to a running task.",
            properties={
                "task_id": {
                    "type": "string",
                    "description": "Task ID to steer (short ID or full UUID).",
                },
                "message": {
                    "type": "string",
                    "description": "Steering instruction to send to the task.",
                },
            },
            required=["task_id", "message"],
        )


class Trade(GameClientTool):
    def __call__(self, commodity, quantity, trade_type):
        return self.game_client.trade(
            commodity=commodity,
            quantity=quantity,
            trade_type=trade_type,
            character_id=self.game_client.character_id,
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="trade",
            description=(
                "Execute a trade at the current port. BEFORE CALLING, check your status info: "
                "(1) Port code (e.g., BBS): position 1=QF, 2=RO, 3=NS. B=you SELL, S=you BUY. "
                "(2) Empty holds: if 0, do NOT attempt to buy. "
                "(3) Your cargo: only sell what you have. "
                "Example: Port BBS means SELL QF (B), SELL RO (B), BUY NS (S). "
                "Always SELL first to free holds before buying."
            ),
            properties={
                "commodity": {
                    "type": "string",
                    "enum": ["quantum_foam", "retro_organics", "neuro_symbolics"],
                    "description": "The commodity to trade",
                },
                "quantity": {
                    "type": "integer",
                    "description": "Amount to trade",
                    "minimum": 1,
                },
                "trade_type": {
                    "type": "string",
                    "enum": ["buy", "sell"],
                    "description": (
                        "Your action: 'buy' to purchase FROM the port (port must have S for that commodity), "
                        "'sell' to sell TO the port (port must have B for that commodity)"
                    ),
                },
            },
            required=["commodity", "quantity", "trade_type"],
        )


class SalvageCollect(GameClientTool):
    def __call__(self, salvage_id):
        return self.game_client.salvage_collect(
            salvage_id=salvage_id, character_id=self.game_client.character_id
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="salvage_collect",
            description="Collect salvage by salvage ID in the current sector.",
            properties={
                "salvage_id": {
                    "type": "string",
                    "description": "Identifier of the salvage container to collect",
                }
            },
            required=["salvage_id"],
        )


class RechargeWarpPower(GameClientTool):
    def __call__(self, units):
        return self.game_client.recharge_warp_power(
            units=units, character_id=self.game_client.character_id
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="recharge_warp_power",
            description="Recharge warp power at a mega-port in Federation Space (2 credits per unit)",
            properties={
                "units": {
                    "type": "integer",
                    "description": "Number of warp power units to recharge",
                    "minimum": 1,
                }
            },
            required=["units"],
        )


class PurchaseFighters(GameClientTool):
    def __call__(self, units: int):
        return self.game_client.purchase_fighters(
            units=units,
            character_id=self.game_client.character_id,
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="purchase_fighters",
            description="Buy fighters at a mega-port armory in Federation Space (50 credits each; requires available fighter capacity).",
            properties={
                "units": {
                    "type": "integer",
                    "description": "Number of fighters to purchase",
                    "minimum": 1,
                }
            },
            required=["units"],
        )


class TransferWarpPower(GameClientTool):
    def __call__(self, units, to_player_name=None, to_ship_id=None, to_ship_name=None):
        return self.game_client.transfer_warp_power(
            units=units,
            to_player_name=to_player_name,
            to_ship_id=to_ship_id,
            to_ship_name=to_ship_name,
            character_id=self.game_client.character_id,
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="transfer_warp_power",
            description=(
                "Transfer warp power to another ship in the same sector. Provide one of "
                "to_player_name, to_ship_id, or to_ship_name. For corporation ships, "
                "use corporation_info to find the ship_id. to_ship_id accepts a full UUID "
                "or a 6-8 hex prefix (unique in the current sector). If you see a name like "
                "'Fast Probe [abcd1234]', the bracket suffix is just a short id."
            ),
            properties={
                "to_player_name": {
                    "type": "string",
                    "description": "Display name of the recipient currently in your sector",
                    "minLength": 1,
                },
                "to_ship_id": {
                    "type": "string",
                    "description": "Ship UUID or 6-8 hex prefix for the recipient ship",
                },
                "to_ship_name": {
                    "type": "string",
                    "description": "Unique ship name for the recipient ship (without bracket suffix)",
                    "minLength": 1,
                },
                "units": {
                    "type": "integer",
                    "description": "Number of warp power units to transfer",
                    "minimum": 1,
                },
            },
            required=["units"],
        )


class TransferCredits(GameClientTool):
    def __call__(self, to_player_name=None, amount=None, to_ship_id=None, to_ship_name=None):
        return self.game_client.transfer_credits(
            amount=amount,
            to_player_name=to_player_name,
            to_ship_id=to_ship_id,
            to_ship_name=to_ship_name,
            character_id=self.game_client.character_id,
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="transfer_credits",
            description=(
                "Transfer on-hand credits to another ship in the same sector. Provide "
                "one of to_player_name, to_ship_id, or to_ship_name. For corporation ships, "
                "use corporation_info to find the ship_id. to_ship_id accepts a full UUID "
                "or a 6-8 hex prefix (unique in the current sector). If you see a name like "
                "'Fast Probe [abcd1234]', the bracket suffix is just a short id."
            ),
            properties={
                "to_player_name": {
                    "type": "string",
                    "description": "Display name of the recipient currently in your sector",
                    "minLength": 1,
                },
                "to_ship_id": {
                    "type": "string",
                    "description": "Ship UUID or 6-8 hex prefix for the recipient ship",
                },
                "to_ship_name": {
                    "type": "string",
                    "description": "Unique ship name for the recipient ship (without bracket suffix)",
                    "minLength": 1,
                },
                "amount": {
                    "type": "integer",
                    "description": "Number of credits to transfer",
                    "minimum": 1,
                },
            },
            required=["amount"],
        )


class CreateCorporation(GameClientTool):
    def __call__(self, name, character_id=None):
        payload = {"name": name}
        if character_id is not None:
            payload["character_id"] = character_id
        else:
            payload["character_id"] = self.game_client.character_id
        return self.game_client.create_corporation(**payload)

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="create_corporation",
            description="Create a new corporation. Requires sufficient ship credits for the founding fee.",
            properties={
                "name": {
                    "type": "string",
                    "description": "Corporation name (3-50 characters)",
                    "minLength": 3,
                    "maxLength": 50,
                },
                "character_id": {
                    "type": "string",
                    "description": "Character founding the corporation (defaults to the authenticated pilot)",
                },
            },
            required=["name"],
        )


class JoinCorporation(GameClientTool):
    async def __call__(
        self,
        invite_code,
        corp_id=None,
        corp_name=None,
        character_id=None,
    ):
        resolved_corp_id = (corp_id or "").strip() if corp_id else ""
        if not resolved_corp_id:
            if not corp_name:
                raise ValueError(
                    "join_corporation requires either corp_id or corp_name."
                )
            corps = await self.game_client.list_corporations()
            match_name = corp_name.strip().lower()
            resolved_corp_id = ""
            for corp in corps:
                name = str(corp.get("name", "")).strip().lower()
                if name == match_name:
                    resolved_corp_id = corp.get("corp_id", "")
                    break
            if not resolved_corp_id:
                raise ValueError(f"Corporation named '{corp_name}' not found.")

        payload = {
            "corp_id": resolved_corp_id,
            "invite_code": invite_code,
        }
        if character_id is not None:
            payload["character_id"] = character_id
        else:
            payload["character_id"] = self.game_client.character_id
        return await self.game_client.join_corporation(**payload)

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="join_corporation",
            description="Join an existing corporation using an invite code.",
            properties={
                "corp_id": {
                    "type": "string",
                    "description": "Corporation identifier to join",
                    "minLength": 1,
                },
                "corp_name": {
                    "type": "string",
                    "description": "Corporation display name to join (case-insensitive). Ignored if corp_id is provided.",
                    "minLength": 1,
                },
                "invite_code": {
                    "type": "string",
                    "description": "Invite code provided by the corporation",
                    "minLength": 1,
                },
                "character_id": {
                    "type": "string",
                    "description": "Character joining the corporation (defaults to the authenticated pilot)",
                },
            },
            required=["invite_code"],
        )


class LeaveCorporation(GameClientTool):
    def __call__(self, character_id=None):
        payload = {}
        if character_id is not None:
            payload["character_id"] = character_id
        else:
            payload["character_id"] = self.game_client.character_id
        return self.game_client.leave_corporation(**payload)

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="leave_corporation",
            description="Leave your current corporation.",
            properties={
                "character_id": {
                    "type": "string",
                    "description": "Character leaving the corporation (defaults to the authenticated pilot)",
                },
            },
            required=[],
        )


class KickCorporationMember(GameClientTool):
    def __call__(self, target_id, character_id=None):
        payload = {
            "target_id": target_id,
        }
        if character_id is not None:
            payload["character_id"] = character_id
        else:
            payload["character_id"] = self.game_client.character_id
        return self.game_client.kick_corporation_member(**payload)

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="kick_corporation_member",
            description="Remove another member from your corporation.",
            properties={
                "target_id": {
                    "type": "string",
                    "description": "Character ID of the member to remove",
                    "minLength": 1,
                },
                "character_id": {
                    "type": "string",
                    "description": "Character executing the kick (defaults to the authenticated pilot)",
                },
            },
            required=["target_id"],
        )


class PurchaseShip(GameClientTool):
    def __call__(
        self,
        ship_type,
        purchase_type=None,
        ship_name=None,
        trade_in_ship_id=None,
        corp_id=None,
        initial_ship_credits=None,
        character_id=None,
    ):
        payload = {
            "ship_type": ship_type,
        }
        if ship_name is not None and str(ship_name).strip():
            payload["ship_name"] = ship_name
        if purchase_type is not None:
            payload["purchase_type"] = purchase_type
        if trade_in_ship_id is not None:
            payload["trade_in_ship_id"] = trade_in_ship_id
        if corp_id is not None:
            payload["corp_id"] = corp_id
        if initial_ship_credits is not None:
            payload["initial_ship_credits"] = initial_ship_credits
        if character_id is not None:
            payload["character_id"] = character_id
        else:
            payload["character_id"] = self.game_client.character_id
        return self.game_client.purchase_ship(**payload)

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="purchase_ship",
            description=(
                "Purchase a ship for personal use or on behalf of your corporation. "
                "Personal purchases use ship credits (with trade-in value from current ship). "
                "Corporation purchases draw from bank credits and may seed initial ship credits. "
                "If ship_name is omitted, the default display name is used and auto-suffixed "
                "for uniqueness. "
                "Note: autonomous ships (autonomous_probe, autonomous_light_hauler) can ONLY be "
                "purchased for corporations, not for personal use."
            ),
            properties={
                "ship_type": {
                    "type": "string",
                    "enum": [
                        "kestrel_courier",       # 25,000 - starter ship
                        "sparrow_scout",         # 35,000 - recon
                        "wayfarer_freighter",    # 120,000 - main trader
                        "pioneer_lifter",        # 220,000 - logistics
                        "atlas_hauler",          # 260,000 - bulk cargo
                        "corsair_raider",        # 180,000 - pirate
                        "pike_frigate",          # 300,000 - assault
                        "bulwark_destroyer",     # 450,000 - line combat
                        "aegis_cruiser",         # 700,000 - control/escort
                        "sovereign_starcruiser", # 2,500,000 - flagship
                        "autonomous_probe",      # 1,000 - corp only
                        "autonomous_light_hauler",  # 5,000 - corp only
                    ],
                    "description": (
                        "Ship type to purchase. Autonomous types (autonomous_probe, "
                        "autonomous_light_hauler) are corporation-only."
                    ),
                },
                "purchase_type": {
                    "type": "string",
                    "enum": ["personal", "corporation"],
                    "description": "Whether this purchase is personal or for the corporation (default personal).",
                },
                "ship_name": {
                    "type": "string",
                    "description": "Optional display name for the new ship",
                    "minLength": 1,
                },
                "trade_in_ship_id": {
                    "type": "string",
                    "description": "Ship ID to trade in when making a personal purchase",
                },
                "corp_id": {
                    "type": "string",
                    "description": "Corporation ID when purchasing for a corporation (defaults to your membership)",
                },
                "initial_ship_credits": {
                    "type": "integer",
                    "description": "Credits to seed into the ship when purchasing for a corporation",
                    "minimum": 0,
                },
                "character_id": {
                    "type": "string",
                    "description": "Character executing the purchase (defaults to the authenticated pilot)",
                },
            },
            required=["ship_type"],
        )


class RenameShip(GameClientTool):
    def __call__(self, ship_name, ship_id=None):
        payload = {"ship_name": ship_name}
        if ship_id is not None:
            payload["ship_id"] = ship_id
        return self.game_client.rename_ship(**payload)

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="rename_ship",
            description=(
                "Rename a ship you own. For corporation ships, call corporation_info() "
                "to find the ship_id. ship_id accepts a full UUID or a 6-8 hex prefix "
                "(must uniquely identify a ship you control)."
            ),
            properties={
                "ship_name": {
                    "type": "string",
                    "description": "New display name for the ship",
                    "minLength": 1,
                },
                "ship_id": {
                    "type": "string",
                    "description": (
                        "Corporation ship UUID or 6-8 hex prefix to rename. "
                        "Omit this to rename your own active ship."
                    ),
                },
            },
            required=["ship_name"],
        )


class CorporationInfo(GameClientTool):
    async def __call__(self, list_all=False, corp_id=None):
        """
        Get corporation information including members and ships.

        Args:
            list_all: If True, list all corporations.
            corp_id: If provided, look up a specific corporation by ID.
                     If omitted, returns your own corporation's info.
        """
        character_id = self.game_client.character_id

        if list_all:
            # List all corporations
            result = await self.game_client._request("corporation.list", {})
            return {"summary": _summarize_corporation_info(result)}

        if corp_id:
            # Look up a specific corporation by ID
            result = await self.game_client._request(
                "corporation.info",
                {
                    "character_id": character_id,
                    "corp_id": corp_id,
                },
            )
            return {"summary": _summarize_corporation_info(result)}

        # Default: get your own corporation info (no corp_id needed)
        result = await self.game_client._request(
            "my_corporation",
            {
                "character_id": character_id,
            },
        )

        return {"summary": _summarize_corporation_info(result)}

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="corporation_info",
            description="Get corporation information. By default returns your own corporation's info including members and ships. Can also look up a specific corporation by ID, or list all corporations.",
            properties={
                "list_all": {
                    "type": "boolean",
                    "description": "Set to true to list all corporations in the game",
                },
                "corp_id": {
                    "type": "string",
                    "description": "Look up a specific corporation by its ID. Omit to get your own corporation's info.",
                },
            },
            required=[],
        )


class EventQuery(GameClientTool):
    def __call__(
        self,
        start,
        end,
        admin_password=None,
        character_id=None,
        corporation_id=None,
        cursor=None,
        max_rows=None,
        sort_direction=None,
        event_scope=None,
        # Filter fields use filter_ prefix
        filter_sector=None,
        filter_task_id=None,
        filter_event_type=None,
        filter_string_match=None,
    ):
        return self.game_client.event_query(
            start=start,
            end=end,
            admin_password=admin_password,
            character_id=character_id,
            corporation_id=corporation_id,
            cursor=cursor,
            max_rows=max_rows,
            sort_direction=sort_direction,
            event_scope=event_scope,
            filter_sector=filter_sector,
            filter_task_id=filter_task_id,
            filter_event_type=filter_event_type,
            filter_string_match=filter_string_match,
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="event_query",
            description=(
                "Query the event log for a time range. Returns up to 100 events per call. "
                "Response includes 'has_more' (boolean) and 'next_cursor' (event ID) for pagination. "
                "To get more results, call again with cursor=next_cursor from the previous response."
            ),
            properties={
                "start": {
                    "type": "string",
                    "description": "ISO8601 timestamp (inclusive start of range)",
                },
                "end": {
                    "type": "string",
                    "description": "ISO8601 timestamp (exclusive end of range)",
                },
                "admin_password": {
                    "type": "string",
                    "description": "Optional admin password when required for wider queries",
                },
                "character_id": {
                    "type": "string",
                    "description": "Character ID for permissions (who is querying). Auto-injected if not provided.",
                },
                "corporation_id": {
                    "type": "string",
                    "description": "Corporation ID for scope (view corp events)",
                },
                "cursor": {
                    "type": "integer",
                    "description": (
                        "Pagination cursor (event ID). For forward sort, returns events after this ID. "
                        "For reverse sort, returns events before this ID. "
                        "Use the 'next_cursor' value from a previous response to get the next page."
                    ),
                },
                "filter_sector": {
                    "type": "integer",
                    "description": "Filter to events within a sector",
                    "minimum": 0,
                },
                "filter_task_id": {
                    "type": "string",
                    "description": (
                        "Filter to events from a specific task. Accepts full UUID or short ID "
                        "(first 6 hex chars, e.g., '6c4393'). Short IDs appear in event summaries as [task=6c4393]."
                    ),
                },
                "filter_event_type": {
                    "type": "string",
                    "description": "Filter to a specific event type (e.g., 'task.start', 'task.finish', 'movement.complete')",
                },
                "filter_string_match": {
                    "type": "string",
                    "description": "Optional literal substring to search for within event payloads",
                },
                "max_rows": {
                    "type": "integer",
                    "description": "Maximum number of events to return (defaults to 100, max 100)",
                    "minimum": 1,
                    "maximum": 100,
                },
                "sort_direction": {
                    "type": "string",
                    "enum": ["forward", "reverse"],
                    "description": "Return events in chronological order ('forward') or reverse chronological order ('reverse'). Defaults to forward.",
                },
                "event_scope": {
                    "type": "string",
                    "enum": ["personal", "corporation"],
                    "description": (
                        "Scope of events to query. Defaults to 'personal' (only your own events). "
                        "Use 'corporation' to see events for all corp members and corp-tagged events "
                        "(e.g., corp ship tasks, shared trade history). Falls back to personal if not in a corp."
                    ),
                },
            },
            required=["start", "end"],
        )


class BankDeposit(GameClientTool):
    def __call__(
        self,
        amount,
        target_player_name,
        ship_id=None,
        ship_name=None,
        character_id=None,
    ):
        payload = {
            "amount": amount,
            "target_player_name": target_player_name,
        }
        if ship_id is not None:
            payload["ship_id"] = ship_id
        if ship_name is not None:
            payload["ship_name"] = ship_name
        if character_id is not None:
            payload["character_id"] = character_id
        elif ship_id is None:
            payload["character_id"] = self.game_client.character_id

        return self.game_client.deposit_to_bank(**payload)

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="bank_deposit",
            description=(
                "Deposit ship credits into a mega-port bank account in Federation Space. "
                "Provide your active ship automatically or specify a corporation ship. "
                "You may only deposit to yourself or (when in the same corporation) to another member."
            ),
            properties={
                "amount": {
                    "type": "integer",
                    "description": "Number of credits to deposit",
                    "minimum": 1,
                },
                "ship_id": {
                    "type": "string",
                    "description": "ID (or 6-8 hex prefix) of the ship funding the deposit (omit to use your active ship)",
                },
                "ship_name": {
                    "type": "string",
                    "description": "Name of the ship funding the deposit (omit to use your active ship)",
                },
                "character_id": {
                    "type": "string",
                    "description": "Character initiating the deposit (defaults to the authenticated pilot)",
                },
                "target_player_name": {
                    "type": "string",
                    "description": "Display name of the bank account owner receiving the deposit",
                    "minLength": 1,
                },
            },
            required=["amount", "target_player_name"],
        )


class BankWithdraw(GameClientTool):
    def __call__(self, amount, character_id=None):
        if character_id is None:
            character_id = self.game_client.character_id
        return self.game_client.withdraw_from_bank(
            amount=amount,
            character_id=character_id,
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="bank_withdraw",
            description="Withdraw credits from your own mega-port bank account in Federation Space back onto your ship.",
            properties={
                "amount": {
                    "type": "integer",
                    "description": "Number of credits to withdraw",
                    "minimum": 1,
                },
                "character_id": {
                    "type": "string",
                    "description": "Character withdrawing funds (defaults to the authenticated pilot)",
                },
            },
            required=["amount"],
        )


class DumpCargo(GameClientTool):
    def __call__(self, items):
        normalized_items = self._normalize_items(items)
        return self.game_client.dump_cargo(
            items=normalized_items, character_id=self.game_client.character_id
        )

    def _normalize_items(self, items):
        if not isinstance(items, list):
            raise ValueError(
                "dump_cargo items must be a list of objects like "
                '[{"commodity":"quantum_foam","units":1}]'
            )

        normalized = []
        for entry in items:
            if isinstance(entry, str):
                parsed = self._parse_item_string(entry)
                if not parsed:
                    raise ValueError(
                        "dump_cargo items must be objects like "
                        '{"commodity":"quantum_foam","units":1}'
                    )
                normalized.append(parsed)
                continue

            if not isinstance(entry, dict):
                raise ValueError(
                    "dump_cargo items must be objects like "
                    '{"commodity":"quantum_foam","units":1}'
                )

            commodity = entry.get("commodity")
            units = entry.get("units")
            if commodity is None or units is None:
                raise ValueError(
                    "dump_cargo items must include commodity and units, e.g. "
                    '{"commodity":"quantum_foam","units":1}'
                )

            if isinstance(units, str) and units.isdigit():
                units = int(units)

            normalized.append({**entry, "units": units})

        return normalized

    def _parse_item_string(self, entry: str):
        if not entry:
            return None
        parts = [part.strip() for part in entry.split(",") if part.strip()]
        if not parts:
            return None
        parsed = {}
        for part in parts:
            if ":" not in part:
                return None
            key, value = part.split(":", 1)
            key = key.strip()
            value = value.strip()
            if key == "commodity":
                parsed["commodity"] = value
            elif key == "units":
                if value.isdigit():
                    parsed["units"] = int(value)
                else:
                    return None
        if "commodity" in parsed and "units" in parsed:
            return parsed
        return None

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="dump_cargo",
            description=(
                "Jettison cargo into space to create salvage in the current sector. "
                "Example: dump_cargo({\"items\": [{\"commodity\": \"quantum_foam\", \"units\": 1}]})"
            ),
            properties={
                "items": {
                    "type": "array",
                    "description": "List of cargo entries to dump. Each entry requires a commodity and units.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "commodity": {
                                "type": "string",
                                "enum": [
                                    "quantum_foam",
                                    "retro_organics",
                                    "neuro_symbolics",
                                ],
                            },
                            "units": {
                                "type": "integer",
                                "minimum": 1,
                            },
                        },
                        "required": ["commodity", "units"],
                    },
                    "minItems": 1,
                }
            },
            required=["items"],
        )


class SendMessage(GameClientTool):
    def __call__(
        self,
        content,
        msg_type="broadcast",
        to_name=None,
        to_ship_id=None,
        to_ship_name=None,
    ):
        return self.game_client.send_message(
            content=content,
            msg_type=msg_type,
            to_name=to_name,
            to_ship_id=to_ship_id,
            to_ship_name=to_ship_name,
            character_id=self.game_client.character_id,
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="send_message",
            description=(
                "Send a chat message (broadcast or direct). For direct messages, you can "
                "target by character name, ship name, or ship_id. to_ship_id accepts a full "
                "UUID or a 6-8 hex prefix (unique within your corporation). If you see a "
                "name like 'Fast Probe [abcd1234]', the bracket suffix is just a short id."
            ),
            properties={
                "content": {
                    "type": "string",
                    "description": "Message text (max 512 chars)",
                },
                "msg_type": {
                    "type": "string",
                    "enum": ["broadcast", "direct"],
                    "description": "Message type",
                    "default": "broadcast",
                },
                "to_name": {
                    "type": "string",
                    "description": "Recipient character name or ship name (required for direct unless using ship_id)",
                },
                "to_ship_id": {
                    "type": "string",
                    "description": "Ship UUID or 6-8 hex prefix for the recipient ship (direct messages)",
                },
                "to_ship_name": {
                    "type": "string",
                    "description": "Ship name for the recipient ship (direct messages, no bracket suffix)",
                },
            },
            required=["content"],
        )


##


class CombatInitiate(GameClientTool):
    def __call__(self, target_id=None, target_type="character"):
        payload = {
            "character_id": self.game_client.character_id,
        }
        if target_id is not None:
            payload["target_id"] = target_id
            payload["target_type"] = target_type or "character"
        return self.game_client.combat_initiate(**payload)

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="combat_initiate",
            description="Start a combat encounter in the current sector. Requires fighters aboard.",
            properties={
                "target_id": {
                    "type": "string",
                    "description": "Optional explicit target combatant identifier.",
                },
                "target_type": {
                    "type": "string",
                    "description": "Type of the specified target (default 'character').",
                    "default": "character",
                },
            },
            required=[],
        )


class CombatAction(GameClientTool):
    async def __call__(
        self,
        *,
        combat_id,
        action,
        commit: int = 0,
        target_id: Optional[str] = None,
        to_sector: Optional[int] = None,
        round_number: Optional[int] = None,
    ):
        action_value = str(action).lower()
        return await self.game_client.combat_action(
            combat_id=combat_id,
            action=action_value,
            commit=commit,
            target_id=target_id,
            to_sector=to_sector,
            character_id=self.game_client.character_id,
            round_number=round_number,
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="combat_action",
            description=(
                "Submit your combat round decision. Valid actions: attack, brace, flee, or pay. "
                "Provide commit and target_id when attacking; include to_sector when fleeing."
            ),
            properties={
                "combat_id": {
                    "type": "string",
                    "description": "Active combat encounter identifier.",
                },
                "action": {
                    "type": "string",
                    "enum": ["attack", "brace", "flee", "pay"],
                    "description": "Action to perform this round.",
                },
                "commit": {
                    "type": "integer",
                    "description": "Number of fighters to commit when attacking.",
                    "minimum": 0,
                },
                "target_id": {
                    "type": "string",
                    "description": "Target combatant identifier (required for attack).",
                },
                "to_sector": {
                    "type": "integer",
                    "description": "Destination sector when fleeing.",
                },
                "round_number": {
                    "type": "integer",
                    "description": "Optional round number hint for concurrency control.",
                    "minimum": 1,
                },
            },
            required=["combat_id", "action"],
        )


class WaitInIdleState(Tool):
    """Tool allowing the agent to idle while still receiving events."""

    def __init__(
        self,
        *,
        agent: Optional[Any] = None,
        game_client: Optional[AsyncGameClient] = None,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self.agent = agent
        self.game_client = game_client

    def bind_agent(self, agent: Any) -> None:
        self.agent = agent

    async def __call__(self, seconds: Optional[int] = None) -> Any:
        if self.agent is None:
            raise RuntimeError("WaitInIdleState requires an agent reference")
        if seconds is None:
            seconds = 60
        return await self.agent.wait_in_idle_state(seconds=seconds)

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="wait_in_idle_state",
            description=(
                "Pause in an idle state while still listening for live events. "
                "Use only for long waits on external events (e.g., another player arriving "
                "or a chat.message). Do NOT use for movement/combat/trade completions. "
                "If no events arrive before the timeout, an idle.complete event is emitted."
            ),
            properties={
                "seconds": {
                    "type": "integer",
                    "description": "Seconds to remain idle (1-60). Defaults to 60.",
                    "minimum": 1,
                    "maximum": 60,
                    "default": 60,
                }
            },
            required=[],
        )


class TaskFinished(Tool):
    def __call__(self, message="Done"):
        return {"success": True, "message": message}

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="finished",
            description="Signal that you have completed the assigned task",
            properties={
                "message": {
                    "type": "string",
                    "description": "Completion message describing what was accomplished",
                    "default": "Task completed",
                }
            },
            required=["message"],
        )


class PlaceFighters(GameClientTool):
    def __call__(self, sector, quantity, mode="offensive", toll_amount=0):
        return self.game_client.combat_leave_fighters(
            sector=sector,
            quantity=quantity,
            mode=mode,
            toll_amount=toll_amount,
            character_id=self.game_client.character_id,
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="place_fighters",
            description="Leave fighters behind in the current sector as a garrison.",
            properties={
                "sector": {
                    "type": "integer",
                    "description": "Sector ID where fighters will be stationed",
                    "minimum": 0,
                },
                "quantity": {
                    "type": "integer",
                    "description": "Number of fighters to leave behind",
                    "minimum": 1,
                },
                "mode": {
                    "type": "string",
                    "enum": ["offensive", "defensive", "toll"],
                    "description": "Behavior mode for stationed fighters",
                    "default": "offensive",
                },
                "toll_amount": {
                    "type": "integer",
                    "description": "Credits required to pass when mode is toll",
                    "minimum": 0,
                    "default": 0,
                },
            },
            required=["sector", "quantity"],
        )


class CollectFighters(GameClientTool):
    def __call__(self, sector, quantity):
        return self.game_client.combat_collect_fighters(
            sector=sector, quantity=quantity, character_id=self.game_client.character_id
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="collect_fighters",
            description="Retrieve fighters previously stationed in the current sector.",
            properties={
                "sector": {
                    "type": "integer",
                    "description": "Sector ID to collect fighters from",
                    "minimum": 0,
                },
                "quantity": {
                    "type": "integer",
                    "description": "Number of fighters to retrieve",
                    "minimum": 1,
                },
            },
            required=["sector", "quantity"],
        )


##


class LoadGameInfo(Tool):
    """Tool to load detailed game information on demand."""

    def __call__(self, topic: str) -> dict:
        from gradientbang.utils.prompt_loader import load_fragment, AVAILABLE_TOPICS

        if topic not in AVAILABLE_TOPICS:
            return {
                "error": f"Unknown topic: {topic}. Available topics: {', '.join(AVAILABLE_TOPICS)}"
            }
        try:
            content = load_fragment(topic)
            return {"topic": topic, "content": content}
        except FileNotFoundError as exc:
            return {"error": str(exc)}

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="load_game_info",
            description=(
                "Load detailed game information about a specific topic. "
                "Use when you need in-depth rules or mechanics."
            ),
            properties={
                "topic": {
                    "type": "string",
                    "enum": [
                        "exploration",
                        "trading",
                        "combat",
                        "corporations",
                        "transfers",
                        "ships",
                        "event_logs",
                    ],
                    "description": "The topic to load detailed information about",
                },
            },
            required=["topic"],
        )


##

UI_SHOW_PANEL_SCHEMA = FunctionSchema(
    name="ui_show_panel",
    description="Switch to and highlight a panel in the client UI",
    properties={
        "panel": {
            "type": "string",
            "description": "Name of the panel to switch to. One of 'task_output', 'movement_history', 'ports_discovered' or 'trade'",
        },
    },
    required=["panel"],
)
