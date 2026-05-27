"""Cekura PipecatTracer integration for simulation tracing.

Singleton tracer — call init_cekura() once at startup, then use
is_cekura_enabled() / get_tracer() anywhere. append_context_dump()
accumulates LLM context dumps keyed by S3 key and pushes them to
Cekura as custom metadata.
"""

import time
from typing import Any, Dict, List, Optional

from cekura.pipecat import PipecatTracer
from loguru import logger

from gradientbang.config import settings

_tracer: Optional[PipecatTracer] = None


def init_cekura() -> Optional[PipecatTracer]:
    global _tracer
    if not settings.CEKURA_TRACER_ENABLED:
        return None

    api_key = settings.CEKURA_API_KEY
    agent_id = settings.CEKURA_AGENT_ID
    if not api_key or not agent_id:
        return None

    _tracer = PipecatTracer(
        api_key=api_key,
        agent_id=int(agent_id),
        enabled=True,
    )
    logger.info("Cekura tracing initialized")
    return _tracer


def is_cekura_enabled() -> bool:
    return _tracer is not None and _tracer.enabled


def get_tracer() -> Optional[PipecatTracer]:
    return _tracer


def cekura_append_context_dump(value: List[Dict[str, Any]]) -> None:
    if not _tracer:
        return
    key = f"context_dump_{time.time_ns()}"
    metadata = _tracer.get_custom_metadata()
    context_dumps = metadata.get("context_dumps", {})
    context_dumps[key] = value
    metadata["context_dumps"] = context_dumps
    _tracer.set_custom_metadata(metadata)
