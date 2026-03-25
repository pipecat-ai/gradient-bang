"""Proxy agents for forwarding bus messages over network transports."""

from gradientbang.subagents.agents.proxy.websocket import (
    WebSocketProxyClientAgent,
    WebSocketProxyServerAgent,
)

__all__ = [
    "WebSocketProxyClientAgent",
    "WebSocketProxyServerAgent",
]
