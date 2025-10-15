# tools_schema.py

from abc import ABC
from typing import List

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
    def __call__(self, to_character_id, units):
        return self.game_client.transfer_warp_power(
            to_character_id=to_character_id,
            units=units,
            character_id=self.game_client.character_id
        )

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="transfer_warp_power",
            description="Transfer warp power to another character in the same sector",
            properties={
                "to_character_id": {
                    "type": "string",
                    "description": "Character ID to transfer warp power to",
                    "minLength": 1,
                    "maxLength": 100,
                },
                "units": {
                    "type": "integer",
                    "description": "Number of warp power units to transfer",
                    "minimum": 1,
                },
            },
            required=["to_character_id", "units"],
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
