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
    for tool_class in tools_classes:
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
    def __call__(self, tool_call):
        return self.game_client.my_status()

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="my_status",
            description="Get your current status including current sector position",
            properties={},
            required=[],
        )


class MyMap(GameClientTool):
    def __call__(self, **args):
        return self.game_client.my_map(**args)

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="my_map",
            description="Get your map knowledge including all visited sectors, known ports, and discovered connections",
            properties={},
            required=[],
        )


class PlotCourse(GameClientTool):
    def __call__(self, **args):
        return self.game_client.plot_course(**args)

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="plot_course",
            description="Calculate shortest path between two sectors",
            properties={
                "from_sector": {
                    "type": "integer",
                    "description": "Starting sector ID",
                    "minimum": 0,
                },
                "to_sector": {
                    "type": "integer",
                    "description": "Destination sector ID",
                    "minimum": 0,
                },
            },
            required=["from_sector", "to_sector"],
        )


class Move(GameClientTool):
    def __call__(self, **args):
        return self.game_client.move(**args)

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
    def __call__(self, **args):
        return self.game_client.start_task(**args)

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
    def __call__(self, **args):
        return self.game_client.stop_task()

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="stop_task",
            description="Cancel the currently running task",
            properties={},
            required=[],
        )


class CheckTrade(GameClientTool):
    def __call__(self, **args):
        return self.game_client.check_trade(**args)

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="check_trade",
            description="Preview a trade transaction without executing it",
            properties={
                "commodity": {
                    "type": "string",
                    "enum": ["fuel_ore", "organics", "equipment"],
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


class Trade(GameClientTool):
    def __call__(self, **args):
        return self.game_client.trade(**args)

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="trade",
            description="Execute a trade transaction at the current port",
            properties={
                "commodity": {
                    "type": "string",
                    "enum": ["fuel_ore", "organics", "equipment"],
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


class BuyWarpPower(GameClientTool):
    def __call__(self, **args):
        return self.game_client.buy_warp_power(**args)

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="buy_warp_power",
            description="Buy warp power at the special depot in sector 0 (2 credits per unit)",
            properties={
                "units": {
                    "type": "integer",
                    "description": "Number of warp power units to buy",
                    "minimum": 1,
                }
            },
            required=["units"],
        )


class TransferWarpPower(GameClientTool):
    def __call__(self, **args):
        return self.game_client.transfer_warp_power(**args)

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


##


class TaskFinished(Tool):
    def __call__(self, **args):
        return {"success": True, "message": args.get("message", "Done")}

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


##

UI_SHOW_PANEL_SCHEMA = FunctionSchema(
    name="ui_show_panel",
    description="Switch to and highlight a panel in the client UI",
    properties={
        "panel": {
            "type": "string",
            "description": "Name of the panel to switch to. One of 'task_output', 'movement_history', 'ports_discovered' or 'debug'",
        },
    },
    required=["panel"],
)
