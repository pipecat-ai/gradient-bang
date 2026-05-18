"""Tool schemas for the single-turn SMS/WhatsApp agent."""

from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema


STATUS = FunctionSchema(
    name="status",
    description=(
        "Get the commander's current Gradient Bang status, including current sector, "
        "ship, resources, nearby sector details, port, and local players."
    ),
    properties={},
    required=[],
)

SHIPS = FunctionSchema(
    name="ships",
    description=(
        "List the commander's accessible ships, including personal and corporation ships."
    ),
    properties={},
    required=[],
)

CORPORATION_INFO = FunctionSchema(
    name="corporation_info",
    description=(
        "Get the commander's corporation information, including members and corporation ships."
    ),
    properties={},
    required=[],
)

MAP = FunctionSchema(
    name="map",
    description=(
        "Return a placeholder visual star chart for the commander's current map view."
    ),
    properties={},
    required=[],
)


SMS_AGENT_TOOLS = ToolsSchema([STATUS, SHIPS, CORPORATION_INFO, MAP])
