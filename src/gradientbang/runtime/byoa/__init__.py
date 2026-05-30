"""BYOA (Bring-Your-Own-Agent) primitives.

Configuration surface for external agents that control corporation ships
over the Gradient Bang subagent bus. The bundled in-process TaskAgent uses
the same surface, so a BYOA operator's implementation has a 1:1 reference.

Public API:

* :class:`ByoaApp` — the default harness; instantiate and call ``.run()``
  for the zero-config path, or attach hooks via ``@app.prompt``, ``@app.llm``,
  ``@app.on_session_start``, ``@app.on_session_end``, ``@app.on_combat_wake``.
* :class:`ByoaContext` — what hooks receive: ship_id, character_id, channel,
  bus_dsn, prompt, config, …
* :class:`ByoaCombatWake` — replacement text returned from combat wake hooks.
* :class:`ByoaAgentConfig` — runtime tunables (RPC timeouts, wake timeout,
  in-process corp-agent idle teardown).
* :class:`ByoaConfigError` — raised for missing/malformed BYOA env vars.
"""

from gradientbang.runtime.byoa.app import (
    ByoaApp,
    ByoaCombatWake,
    ByoaConfigError,
    ByoaContext,
)
from gradientbang.runtime.byoa.config import ByoaAgentConfig

__all__ = [
    "ByoaAgentConfig",
    "ByoaApp",
    "ByoaCombatWake",
    "ByoaConfigError",
    "ByoaContext",
]
