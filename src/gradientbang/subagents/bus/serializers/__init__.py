"""Bus message serialization for network transport.

Provides the abstract `MessageSerializer` interface and a default
`JSONMessageSerializer` implementation.
"""

from gradientbang.subagents.bus.serializers.base import MessageSerializer
from gradientbang.subagents.bus.serializers.json import JSONMessageSerializer

__all__ = [
    "JSONMessageSerializer",
    "MessageSerializer",
]
