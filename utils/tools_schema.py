# tools_schema.py

from abc import ABC
from typing import Any, List, Optional

from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.services.open_ai_adapter import OpenAILLMAdapter

from utils.api_client import AsyncGameClient

from openai.types.chat import ChatCompletionToolParam


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
            to_sector=to_sector,
            character_id=self.game_client.character_id
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
    def __call__(self, from_sector=None, max_hops=5, port_type=None, commodity=None, trade_type=None):
        return self.game_client.list_known_ports(
            character_id=self.game_client.character_id,
            from_sector=from_sector,
            max_hops=max_hops,
            port_type=port_type,
            commodity=commodity,
            trade_type=trade_type,
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="list_known_ports",
            description="Find all known ports within travel range for trading/planning. Useful for finding nearest port of specific type or ports that buy/sell specific commodities.",
            properties={
                "from_sector": {
                    "type": "integer",
                    "description": "Optional starting sector; defaults to current sector",
                    "minimum": 0,
                },
                "max_hops": {
                    "type": "integer",
                    "description": "Maximum distance (default 5, max 10)",
                    "minimum": 1,
                    "maximum": 10,
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
            to_sector=to_sector,
            character_id=self.game_client.character_id
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
    def __call__(self, task_description, context=None):
        kwargs = {"task_description": task_description}
        if context:
            kwargs["context"] = context
        return self.game_client.start_task(**kwargs)

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="start_task",
            description="Start a complex multi-step task for navigation, trading, or exploration",
            properties={
                "task_description": {
                    "type": "string",
                    "description": "Natural language description of the task to execute",
                },
                "context": {
                    "type": "string",
                    "description": "Relevant conversation history or clarifications",
                },
            },
            required=["task_description"],
        )


class StopTask(GameClientTool):
    def __call__(self):
        return self.game_client.stop_task()

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="stop_task",
            description="Cancel the currently running task",
            properties={},
            required=[],
        )


class Trade(GameClientTool):
    def __call__(self, commodity, quantity, trade_type):
        return self.game_client.trade(
            commodity=commodity,
            quantity=quantity,
            trade_type=trade_type,
            character_id=self.game_client.character_id
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="trade",
            description="Execute a trade transaction at the current port (buy or sell commodities)",
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
                    "description": "Whether to buy from or sell to the port",
                },
            },
            required=["commodity", "quantity", "trade_type"],
        )


class SalvageCollect(GameClientTool):
    def __call__(self, salvage_id):
        return self.game_client.salvage_collect(
            salvage_id=salvage_id,
            character_id=self.game_client.character_id
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
            units=units,
            character_id=self.game_client.character_id
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="recharge_warp_power",
            description="Recharge warp power at the special depot in sector 0 (2 credits per unit)",
            properties={
                "units": {
                    "type": "integer",
                    "description": "Number of warp power units to recharge",
                    "minimum": 1,
                }
            },
            required=["units"],
        )


class TransferWarpPower(GameClientTool):
    def __call__(self, to_player_name, units):
        return self.game_client.transfer_warp_power(
            to_player_name=to_player_name,
            units=units,
            character_id=self.game_client.character_id
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="transfer_warp_power",
            description="Transfer warp power to another character in the same sector",
            properties={
                "to_player_name": {
                    "type": "string",
                    "description": "Display name of the recipient currently in your sector",
                    "minLength": 1,
                },
                "units": {
                    "type": "integer",
                    "description": "Number of warp power units to transfer",
                    "minimum": 1,
                },
            },
            required=["to_player_name", "units"],
        )


class TransferCredits(GameClientTool):
    def __call__(self, to_player_name, amount):
        return self.game_client.transfer_credits(
            to_player_name=to_player_name,
            amount=amount,
            character_id=self.game_client.character_id
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="transfer_credits",
            description="Transfer on-hand credits to another character in the same sector.",
            properties={
                "to_player_name": {
                    "type": "string",
                    "description": "Display name of the recipient currently in your sector",
                    "minLength": 1,
                },
                "amount": {
                    "type": "integer",
                    "description": "Number of credits to transfer",
                    "minimum": 1,
                },
            },
            required=["to_player_name", "amount"],
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
                raise ValueError("join_corporation requires either corp_id or corp_name.")
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
        if ship_name is None or not str(ship_name).strip():
            raise ValueError("ship_name is required when purchasing a ship.")

        payload = {
            "ship_type": ship_type,
            "ship_name": ship_name,
        }
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
                "Corporation purchases draw from bank credits and may seed initial ship credits."
            ),
            properties={
                "ship_type": {
                    "type": "string",
                    "description": "Ship type identifier (e.g., 'kestrel_courier', 'atlas_hauler')",
                },
                "purchase_type": {
                    "type": "string",
                    "enum": ["personal", "corporation"],
                    "description": "Whether this purchase is personal or for the corporation (default personal).",
                },
                "ship_name": {
                    "type": "string",
                    "description": "Display name for the new ship",
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
            required=["ship_type", "ship_name"],
        )


class EventQuery(GameClientTool):
    def __call__(
        self,
        start,
        end,
        admin_password=None,
        character_id=None,
        sector=None,
        corporation_id=None,
    ):
        return self.game_client.event_query(
            start=start,
            end=end,
            admin_password=admin_password,
            character_id=character_id,
            sector=sector,
            corporation_id=corporation_id,
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="event_query",
            description="Query the event log for a time range. Useful for diagnostics or summarizing recent activity.",
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
                    "description": "Filter to a specific character's events",
                },
                "sector": {
                    "type": "integer",
                    "description": "Filter to events within a sector",
                    "minimum": 0,
                },
                "corporation_id": {
                    "type": "string",
                    "description": "Filter to events involving the given corporation",
                },
            },
            required=["start", "end"],
        )


class BankDeposit(GameClientTool):
    def __call__(self, amount, target_player_name, ship_id=None, character_id=None):
        payload = {
            "amount": amount,
            "target_player_name": target_player_name,
        }
        if ship_id is not None:
            payload["ship_id"] = ship_id
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
                "Deposit ship credits into a megaport bank account. "
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
                    "description": "ID of the ship funding the deposit (omit to use your active ship)",
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
            description="Withdraw credits from your own megaport bank account back onto your ship.",
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
        return self.game_client.dump_cargo(
            items=items,
            character_id=self.game_client.character_id
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="dump_cargo",
            description="Jettison cargo into space to create salvage in the current sector.",
            properties={
                "items": {
                    "type": "array",
                    "description": "List of cargo entries to dump. Each entry requires a commodity and units.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "commodity": {
                                "type": "string",
                                "enum": ["quantum_foam", "retro_organics", "neuro_symbolics"],
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
    def __call__(self, content, msg_type="broadcast", to_name=None):
        return self.game_client.send_message(
            content=content,
            msg_type=msg_type,
            to_name=to_name,
            character_id=self.game_client.character_id
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="send_message",
            description="Send a chat message (broadcast or direct)",
            properties={
                "content": {"type": "string", "description": "Message text (max 512 chars)"},
                "msg_type": {
                    "type": "string",
                    "enum": ["broadcast", "direct"],
                    "description": "Message type",
                    "default": "broadcast",
                },
                "to_name": {
                    "type": "string",
                    "description": "Recipient character name (required for direct)",
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
            character_id=self.game_client.character_id
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
            sector=sector,
            quantity=quantity,
            character_id=self.game_client.character_id
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
