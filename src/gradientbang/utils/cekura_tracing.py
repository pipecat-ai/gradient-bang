"""Cekura PipecatTracer integration for simulation tracing.

Singleton tracer — call init_cekura() once at startup, then use
is_cekura_enabled() / get_tracer() anywhere. append_context_dump()
accumulates LLM context dumps keyed by S3 key and pushes them to
Cekura as custom metadata.
"""

import os
from typing import Any, Dict, List, Optional

from cekura.pipecat import PipecatTracer
from loguru import logger

_tracer: Optional[PipecatTracer] = None


def init_cekura() -> Optional[PipecatTracer]:
    global _tracer
    api_key = os.getenv("CEKURA_API_KEY")
    agent_id = os.getenv("CEKURA_AGENT_ID")
    if not api_key or not agent_id:
        return None

    _tracer = PipecatTracer(
        api_key=api_key,
        agent_id=int(agent_id),
        enabled=os.getenv("CEKURA_TRACER_ENABLED", "").lower() != "false",
    )
    logger.info("Cekura tracing initialized")
    return _tracer


def is_cekura_enabled() -> bool:
    return _tracer is not None and _tracer.enabled


def get_tracer() -> Optional[PipecatTracer]:
    return _tracer


def cekura_append_context_dump(key: str, value: List[Dict[str, Any]]) -> None:
    if not _tracer:
        return
    metadata = _tracer.get_custom_metadata()
    context_dumps = metadata.get("context_dumps", {})
    context_dumps[key] = value
    metadata["context_dumps"] = context_dumps
    _tracer.set_custom_metadata(metadata)
