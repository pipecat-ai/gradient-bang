"""Type adapters for bus message serialization.

Provides ready-made ``TypeAdapter`` implementations for common Pipecat types
(``LLMContext``, ``ToolsSchema``) used in bus messages.
"""

from gradientbang.subagents.bus.adapters.base import TypeAdapter
from gradientbang.subagents.bus.adapters.llm_context_adapter import LLMContextAdapter
from gradientbang.subagents.bus.adapters.tools_schema_adapter import ToolsSchemaAdapter

__all__ = [
    "LLMContextAdapter",
    "ToolsSchemaAdapter",
    "TypeAdapter",
]
