"""BYOA (Bring-Your-Own-Agent) primitives.

Configuration surface for external agents that control corporation ships
over the Gradient Bang subagent bus. The bundled in-process TaskAgent uses
the same surface, so a BYOA operator's implementation has a 1:1 reference.
"""

from gradientbang.byoa.config import ByoaAgentConfig

__all__ = ["ByoaAgentConfig"]
