"""Tool definitions for LLM agents in Gradient Bang."""

from typing import Dict, Any, Optional, List, Literal
from pydantic import BaseModel, Field
import asyncio
from utils.api_client import AsyncGameClient


class PlotCourseTool(BaseModel):
    """Calculate the shortest path between two sectors."""
    from_sector: int = Field(..., description="Starting sector ID")
    to_sector: int = Field(..., description="Destination sector ID")


class MoveTool(BaseModel):
    """Move to an adjacent sector."""
    to_sector: int = Field(..., description="Adjacent sector ID to move to")


class MyStatusTool(BaseModel):
    """Get current character status including position."""
    pass  # No parameters needed


class WaitForTimeTool(BaseModel):
    """Wait for a specified number of seconds."""
    seconds: float = Field(..., ge=0, le=60, description="Number of seconds to wait (max 60)")


class MyMapTool(BaseModel):
    """Get the character's map knowledge including visited sectors and known ports."""
    pass  # No parameters needed



class FindPortTool(BaseModel):
    """Find the nearest known port, optionally filtering by commodity type."""
    from_sector: Optional[int] = Field(
        None,
        description="Optional: Sector to search from (defaults to current sector)"
    )
    commodity: Optional[Literal["fuel_ore", "organics", "equipment"]] = Field(
        None, 
        description="Optional: The commodity to search for (must be exact: 'fuel_ore', 'organics', or 'equipment')"
    )
    buy_or_sell: Optional[Literal["buy", "sell"]] = Field(
        None,
        description="Optional: Whether to find a port that 'buy's or 'sell's the commodity (required if commodity is specified)"
    )


class CheckTradeTool(BaseModel):
    """Check if a trade is possible and get price information."""
    commodity: Literal["fuel_ore", "organics", "equipment"] = Field(
        ...,
        description="The commodity to trade (must be exact: 'fuel_ore', 'organics', or 'equipment')"
    )
    quantity: int = Field(..., gt=0, description="Amount to trade")
    trade_type: Literal["buy", "sell"] = Field(
        ...,
        description="Whether to 'buy' from or 'sell' to the port"
    )


class TradeTool(BaseModel):
    """Execute a trade transaction at the current port."""
    commodity: Literal["fuel_ore", "organics", "equipment"] = Field(
        ...,
        description="The commodity to trade (must be exact: 'fuel_ore', 'organics', or 'equipment')"
    )
    quantity: int = Field(..., gt=0, description="Amount to trade")
    trade_type: Literal["buy", "sell"] = Field(
        ...,
        description="Whether to 'buy' from or 'sell' to the port"
    )


class FindProfitableRouteTool(BaseModel):
    """Find a profitable trade route from known ports."""
    max_distance: int = Field(
        10,
        ge=1,
        le=50,
        description="Maximum distance to consider for trade routes"
    )


class FinishedTool(BaseModel):
    """Signal that the current task is complete."""
    message: str = Field(default="Task completed", description="Completion message")


class BuyWarpPowerTool(BaseModel):
    """Buy warp power at the mega-port in sector 0."""
    units: int = Field(..., gt=0, description="Number of warp power units to buy")


class TransferWarpPowerTool(BaseModel):
    """Transfer warp power to another character in the same sector."""
    to_character_id: str = Field(..., description="Character ID to transfer warp power to")
    units: int = Field(..., gt=0, description="Number of warp power units to transfer")


class AsyncToolExecutor:
    """Executes tools for an LLM agent asynchronously."""

    def __init__(self, game_client: AsyncGameClient, character_id: str, status_callback=None):
        """Initialize the async tool executor.
        
        Args:
            game_client: Async client for game server API calls
            character_id: ID of the character being controlled
            status_callback: Optional callback for status updates
        """
        self.game_client = game_client
        self.character_id = character_id
        self.finished = False
        self.finished_message = ""
        self.status_callback = status_callback

    def _build_sector_info(self, contents: Optional[Any]) -> Dict[str, Any]:
        """Create a standardized sector info dictionary.

        Args:
            contents: Optional sector contents from the server.

        Returns:
            Dictionary with port information, other players, and adjacent sectors.
        """
        sector_info: Dict[str, Any] = {}
        if contents:
            port_info = None
            if getattr(contents, "port", None):
                port = contents.port
                port_info = {
                    "class": port.class_num,
                    "code": port.code,
                    "buys": port.buys,
                    "sells": port.sells,
                    "stock": port.stock,
                    "demand": port.demand,
                }
            sector_info["port_info"] = port_info
            players = getattr(contents, "other_players", []) or []
            try:
                # Handle both cases: list of player objects or list of strings
                if players and hasattr(players[0], 'name'):
                    sector_info["other_players"] = [player.name for player in players]
                else:
                    # Already a list of strings (player names)
                    sector_info["other_players"] = players if isinstance(players, list) else []
            except (TypeError, AttributeError, IndexError):
                sector_info["other_players"] = []
            adjacent = getattr(contents, "adjacent_sectors", [])
            if not isinstance(adjacent, list):
                adjacent = []
            sector_info["adjacent_sectors"] = adjacent
        return sector_info

    async def plot_course(self, from_sector: int, to_sector: int) -> Dict[str, Any]:
        """Execute plot course tool."""
        try:
            result = await self.game_client.plot_course(from_sector, to_sector)
            return {
                "success": True,
                "path": result.path,
                "distance": result.distance,
                "from_sector": result.from_sector,
                "to_sector": result.to_sector
            }
        except Exception as e:
            return {
                "success": False,
                "error": str(e)
            }
    
    async def move(self, to_sector: int) -> Dict[str, Any]:
        """Execute move tool."""
        try:
            # Get the old sector from the client's tracked position
            old_sector = self.game_client.current_sector
            
            # Validate that we know our current position
            if old_sector is None:
                return {
                    "success": False,
                    "error": "Current sector unknown. Run my_status first to establish position."
                }

            result = await self.game_client.move(self.character_id, to_sector)

            # Just pass through the raw move result - LLM understands it fine
            response = {
                "success": True,
                "old_sector": old_sector,  # Keep this for context
                **result.model_dump()  # Pass through all the raw data
            }
            
            # Emit status update
            if self.status_callback:
                self.status_callback(response)
            
            return response
        except Exception as e:
            # Try to extract more detailed error information
            error_msg = str(e)
            if hasattr(e, '__cause__') and e.__cause__:
                error_msg = f"{error_msg} (Caused by: {str(e.__cause__)})"
            
            return {
                "success": False,
                "error": error_msg
            }
    
    async def my_status(self) -> Dict[str, Any]:
        """Execute my-status tool."""
        try:
            result = await self.game_client.my_status()
            
            # Just pass through the raw status data - LLM understands it fine
            response = {
                "success": True,
                **result.model_dump()  # Pass through all the raw status data
            }
            
            # Emit status update
            if self.status_callback:
                self.status_callback(response)
            
            return response
        except Exception as e:
            return {
                "success": False,
                "error": str(e)
            }
    
    async def wait_for_time(self, seconds: float) -> Dict[str, Any]:
        """Execute wait tool."""
        await asyncio.sleep(seconds)
        return {
            "success": True,
            "waited_seconds": seconds
        }
    
    async def my_map(self) -> Dict[str, Any]:
        """Execute my-map tool."""
        try:
            response = await self.game_client.my_map()
            return {
                "success": True,
                **response
            }
        except Exception as e:
            return {
                "success": False,
                "error": str(e)
            }
    
    async def find_port(self, commodity: str = None, buy_or_sell: str = None, from_sector: int = None) -> Dict[str, Any]:
        """Execute find-port tool."""
        try:
            # Use current sector if from_sector not specified
            if from_sector is None:
                from_sector = self.game_client.current_sector
                if from_sector is None:
                    return {
                        "success": False,
                        "error": "No current sector tracked. Run my_status first."
                    }
            
            # If no commodity specified, find ANY nearest port
            if commodity is None:
                result = await self.game_client.find_nearest_known_port(from_sector)
                
                if result is None:
                    return {
                        "success": True,
                        "found": False,
                        "message": f"No known ports found from sector {from_sector}"
                    }
                
                return {
                    "success": True,
                    "found": True,
                    **result
                }
            
            # If commodity specified, buy_or_sell is required
            if buy_or_sell is None:
                return {
                    "success": False,
                    "error": "buy_or_sell is required when commodity is specified"
                }
            
            # Find port with specific commodity
            result = await self.game_client.find_nearest_known_port_with_commodity(
                from_sector,
                commodity,
                buy_or_sell
            )
            
            if result is None:
                return {
                    "success": True,
                    "found": False,
                    "message": f"No known port that {buy_or_sell}s {commodity}"
                }
            
            return {
                "success": True,
                "found": True,
                **result
            }
        except Exception as e:
            return {
                "success": False,
                "error": str(e)
            }
    
    async def finish_task(self, message: str = "Task completed") -> Dict[str, Any]:
        """Execute finished tool."""
        self.finished = True
        self.finished_message = message
        return {
            "success": True,
            "message": message
        }
    
    async def check_trade(
        self,
        commodity: str,
        quantity: int,
        trade_type: str
    ) -> Dict[str, Any]:
        """Check if a trade is possible and get price information."""
        result = await self.game_client.check_trade(
            commodity=commodity,
            quantity=quantity,
            trade_type=trade_type,
            character_id=self.character_id
        )
        
        if result.get("can_trade"):
            return {
                "success": True,
                "can_trade": True,
                "price_per_unit": result.get("price_per_unit"),
                "total_price": result.get("total_price"),
                "current_credits": result.get("current_credits"),
                "current_cargo": result.get("current_cargo")
            }
        else:
            return {
                "success": True,
                "can_trade": False,
                "error": result.get("error", "Cannot trade"),
                "current_credits": result.get("current_credits"),
                "current_cargo": result.get("current_cargo")
            }
    
    async def trade(
        self,
        commodity: str,
        quantity: int,
        trade_type: str
    ) -> Dict[str, Any]:
        """Execute a trade transaction."""
        result = await self.game_client.trade(
            commodity=commodity,
            quantity=quantity,
            trade_type=trade_type,
            character_id=self.character_id
        )
        
        if result.get("success"):
            response = {
                "success": True,
                "trade_type": result.get("trade_type"),
                "commodity": result.get("commodity"),
                "quantity": result.get("quantity"),
                "price_per_unit": result.get("price_per_unit"),
                "total_price": result.get("total_price"),
                "new_credits": result.get("new_credits"),
                "new_cargo": result.get("new_cargo"),
                "message": f"Successfully {trade_type} {quantity} {commodity} for {result.get('total_price')} credits"
            }
            
            # Emit status update for successful trade
            if self.status_callback:
                self.status_callback(result)
            
            return response
        else:
            return {
                "success": False,
                "error": result.get("error", "Trade failed")
            }
    
    async def find_profitable_route(
        self,
        max_distance: int = 10
    ) -> Dict[str, Any]:
        """Find a profitable trade route."""
        route = await self.game_client.find_profitable_route(
            character_id=self.character_id,
            max_distance=max_distance
        )
        
        if route:
            return {
                "success": True,
                "found_route": True,
                "buy_sector": route["buy_sector"],
                "sell_sector": route["sell_sector"],
                "commodity": route["commodity"],
                "buy_price": route["buy_price"],
                "sell_price": route["sell_price"],
                "profit_per_unit": route["profit_per_unit"],
                "total_distance": route["total_distance"],
                "message": f"Found route: Buy {route['commodity']} at sector {route['buy_sector']} for {route['buy_price']}, sell at sector {route['sell_sector']} for {route['sell_price']}"
            }
        else:
            return {
                "success": True,
                "found_route": False,
                "message": "No profitable trade routes found within range"
            }
    
    async def buy_warp_power(self, units: int) -> Dict[str, Any]:
        """Buy warp power at sector 0's mega-port.
        
        Args:
            units: Number of warp power units to buy
            
        Returns:
            Result of the purchase attempt
        """
        import aiohttp
        
        # First check if we're at sector 0
        status = await self.game_client.my_status(self.character_id)
        if status.sector != 0:
            return {
                "success": False,
                "error": f"Must be at sector 0 to buy warp power. Currently at sector {status.sector}"
            }
        
        # Make the API call to buy warp power
        async with aiohttp.ClientSession() as session:
            try:
                async with session.post(
                    f"{self.game_client.base_url}/api/buy_warp_power",
                    json={"character_id": self.character_id, "units": units}
                ) as response:
                    # Try to get JSON response
                    try:
                        result = await response.json()
                    except aiohttp.ContentTypeError:
                        # If response is not JSON, get text
                        text = await response.text()
                        return {
                            "success": False,
                            "error": f"Server returned non-JSON response: {text[:200]}"
                        }
                    
                    if response.status == 200 and result.get("success"):
                        response_data = {
                            "success": True,
                            "units_bought": result.get("units_bought"),
                            "price_per_unit": result.get("price_per_unit"),
                            "total_cost": result.get("total_cost"),
                            "new_warp_power": result.get("new_warp_power"),
                            "warp_power_capacity": result.get("warp_power_capacity"),
                            "new_credits": result.get("new_credits"),
                            "message": result.get("message")
                        }
                        
                        # Emit status update after successful warp power purchase
                        if self.status_callback:
                            # Get fresh status to update the UI
                            fresh_status = await self.game_client.my_status(self.character_id)
                            if fresh_status:
                                self.status_callback(fresh_status.model_dump())
                        
                        return response_data
                    else:
                        return {
                            "success": False,
                            "error": result.get("message") or result.get("detail") or "Failed to buy warp power"
                        }
            except Exception as e:
                return {
                    "success": False,
                    "error": f"Failed to call buy_warp_power API: {str(e)}"
                }
    
    async def transfer_warp_power(self, to_character_id: str, units: int) -> Dict[str, Any]:
        """Transfer warp power to another character in the same sector.
        
        Args:
            to_character_id: Character to transfer to
            units: Number of warp power units to transfer
            
        Returns:
            Result of the transfer attempt
        """
        import aiohttp
        
        async with aiohttp.ClientSession() as session:
            try:
                async with session.post(
                    f"{self.game_client.base_url}/api/transfer_warp_power",
                    json={
                        "from_character_id": self.character_id,
                        "to_character_id": to_character_id,
                        "units": units
                    }
                ) as response:
                    # Try to get JSON response
                    try:
                        result = await response.json()
                    except aiohttp.ContentTypeError:
                        # If response is not JSON, get text
                        text = await response.text()
                        return {
                            "success": False,
                            "error": f"Server returned non-JSON response: {text[:200]}"
                        }
                    
                    if response.status == 200 and result.get("success"):
                        response_data = {
                            "success": True,
                            "units_transferred": result.get("units_transferred"),
                            "from_warp_power_remaining": result.get("from_warp_power_remaining"),
                            "to_warp_power_current": result.get("to_warp_power_current"),
                            "message": result.get("message")
                        }
                        
                        # Emit status update after successful warp power transfer
                        if self.status_callback:
                            # Get fresh status to update the UI
                            fresh_status = await self.game_client.my_status(self.character_id)
                            if fresh_status:
                                self.status_callback(fresh_status.model_dump())
                        
                        return response_data
                    else:
                        return {
                            "success": False,
                            "error": result.get("message") or result.get("detail") or "Failed to transfer warp power"
                        }
            except Exception as e:
                return {
                    "success": False,
                    "error": f"Failed to call transfer_warp_power API: {str(e)}"
                }
    
    async def execute_tool(self, tool_name: str, tool_args: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a tool by name with the given arguments.
        
        Args:
            tool_name: Name of the tool to execute
            tool_args: Arguments for the tool
            
        Returns:
            Tool execution result
        """
        tool_map = {
            "plot_course": self.plot_course,
            "move": self.move,
            "my_status": self.my_status,
            "my_map": self.my_map,
            "find_port": self.find_port,
            "check_trade": self.check_trade,
            "trade": self.trade,
            "find_profitable_route": self.find_profitable_route,
            "buy_warp_power": self.buy_warp_power,
            "transfer_warp_power": self.transfer_warp_power,
            "wait_for_time": self.wait_for_time,
            "finished": self.finish_task,
        }
        
        if tool_name not in tool_map:
            return {
                "success": False,
                "error": f"Unknown tool: {tool_name}"
            }
        
        try:
            # Execute the async tool function with provided arguments
            return await tool_map[tool_name](**tool_args)
        except Exception as e:
            return {
                "success": False,
                "error": f"Tool execution failed: {str(e)}"
            }


def get_tool_definitions() -> List[Dict[str, Any]]:
    """Get OpenAI function calling format tool definitions.
    
    Returns:
        List of tool definitions for OpenAI API
    """
    return [
        {
            "type": "function",
            "function": {
                "name": "plot_course",
                "description": "Calculate the shortest path between two sectors in the game universe",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "from_sector": {
                            "type": "integer",
                            "description": "Starting sector ID"
                        },
                        "to_sector": {
                            "type": "integer",
                            "description": "Destination sector ID"
                        }
                    },
                    "required": ["from_sector", "to_sector"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "move",
                "description": "Move your ship to an adjacent sector. You can only move one sector at a time.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "to_sector": {
                            "type": "integer",
                            "description": "Adjacent sector ID to move to"
                        }
                    },
                    "required": ["to_sector"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "my_status",
                "description": "Get your current status including current sector position",
                "parameters": {
                    "type": "object",
                    "properties": {}
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "my_map",
                "description": "Get your map knowledge including all visited sectors, known ports, and discovered connections",
                "parameters": {
                    "type": "object",
                    "properties": {}
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "find_port",
                "description": "Find the nearest known port. Can optionally filter by commodity type. If no parameters given, finds ANY nearest port.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "from_sector": {
                            "type": "integer",
                            "description": "Optional: Sector to search from (defaults to current sector)"
                        },
                        "commodity": {
                            "type": "string",
                            "description": "Optional: The commodity to search for",
                            "enum": ["fuel_ore", "organics", "equipment"]
                        },
                        "buy_or_sell": {
                            "type": "string",
                            "description": "Optional: Whether to find a port that 'buy's or 'sell's the commodity (required if commodity is specified)",
                            "enum": ["buy", "sell"]
                        }
                    },
                    "required": []
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "wait_for_time",
                "description": "Wait for a specified number of seconds before continuing",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "seconds": {
                            "type": "number",
                            "description": "Number of seconds to wait (max 60)",
                            "minimum": 0,
                            "maximum": 60
                        }
                    },
                    "required": ["seconds"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "check_trade",
                "description": "Check if a trade is possible at the current port and get price information",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "commodity": {
                            "type": "string",
                            "enum": ["fuel_ore", "organics", "equipment"],
                            "description": "The commodity to trade (must be exact: 'fuel_ore', 'organics', or 'equipment')"
                        },
                        "quantity": {
                            "type": "integer",
                            "minimum": 1,
                            "description": "Amount to trade"
                        },
                        "trade_type": {
                            "type": "string",
                            "enum": ["buy", "sell"],
                            "description": "Whether to 'buy' from or 'sell' to the port"
                        }
                    },
                    "required": ["commodity", "quantity", "trade_type"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "trade",
                "description": "Execute a trade transaction at the current port",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "commodity": {
                            "type": "string",
                            "enum": ["fuel_ore", "organics", "equipment"],
                            "description": "The commodity to trade (must be exact: 'fuel_ore', 'organics', or 'equipment')"
                        },
                        "quantity": {
                            "type": "integer",
                            "minimum": 1,
                            "description": "Amount to trade"
                        },
                        "trade_type": {
                            "type": "string",
                            "enum": ["buy", "sell"],
                            "description": "Whether to 'buy' from or 'sell' to the port"
                        }
                    },
                    "required": ["commodity", "quantity", "trade_type"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "find_profitable_route",
                "description": "Find a profitable trade route from known ports",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "max_distance": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 50,
                            "default": 10,
                            "description": "Maximum distance to consider for trade routes"
                        }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "buy_warp_power",
                "description": "Buy warp power at the mega-port in sector 0. You must be at sector 0 to use this.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "units": {
                            "type": "integer",
                            "minimum": 1,
                            "description": "Number of warp power units to buy (2 credits per unit)"
                        }
                    },
                    "required": ["units"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "transfer_warp_power",
                "description": "Transfer warp power to another character in the same sector (for rescue operations)",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "to_character_id": {
                            "type": "string",
                            "description": "Character ID to transfer warp power to"
                        },
                        "units": {
                            "type": "integer",
                            "minimum": 1,
                            "description": "Number of warp power units to transfer"
                        }
                    },
                    "required": ["to_character_id", "units"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "finished",
                "description": "Signal that you have completed the assigned task",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "message": {
                            "type": "string",
                            "description": "Completion message describing what was accomplished",
                            "default": "Task completed"
                        }
                    }
                }
            }
        }
    ]
