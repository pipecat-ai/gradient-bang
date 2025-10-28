#!/usr/bin/env python3
"""Replay a Gemini request using GoogleLLMService._stream_content."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, Optional

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from pipecat.adapters.services.gemini_adapter import GeminiLLMInvocationParams
from pipecat.services.google.llm import GoogleLLMService

from scripts.replay_gemini_invocation import normalize_messages, print_candidate_parts
from utils.experimental_pipecat_agent import (
    DEFAULT_GOOGLE_MODEL,
    DEFAULT_INCLUDE_THOUGHTS,
    DEFAULT_THINKING_BUDGET,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Replay a Gemini request using Pipecat's GoogleLLMService."
    )
    parser.add_argument(
        "invocation_path",
        type=Path,
        help="Path to the JSON file (e.g. full-run.json) containing the invocation payload.",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_GOOGLE_MODEL,
        help=f"Gemini model to use (default: {DEFAULT_GOOGLE_MODEL}).",
    )
    parser.add_argument(
        "--api-key",
        default=None,
        help="Google Generative AI API key (defaults to GOOGLE_API_KEY env var).",
    )
    return parser.parse_args()


def resolve_api_key(explicit_key: Optional[str]) -> str:
    api_key = explicit_key or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        raise SystemExit(
            "No API key provided. Supply --api-key or set the GOOGLE_API_KEY environment variable."
        )
    return api_key


def load_invocation(path: Path) -> Dict[str, Any]:
    if not path.exists():
        raise SystemExit(f"Invocation file not found: {path}")
    try:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Failed to parse JSON file {path}: {exc}") from exc

    invocation = payload.get("invocation", payload)
    if not isinstance(invocation, dict):
        raise SystemExit(
            f"Invocation file {path} does not contain an 'invocation' object."
        )
    return invocation


async def replay_with_service(
    invocation: Dict[str, Any],
    model: str,
    api_key: str,
) -> None:
    messages = normalize_messages(invocation.get("messages", []))
    system_instruction = invocation.get("system_instruction")
    raw_tools = invocation.get("tools")
    tool_config = invocation.get("tool_config")

    params = GeminiLLMInvocationParams(
        system_instruction=system_instruction,
        messages=messages,
        tools=raw_tools,
    )

    service = GoogleLLMService(
        api_key=api_key,
        model=model,
        params=GoogleLLMService.InputParams(
            extra={
                "thinking_config": {
                    "thinking_budget": DEFAULT_THINKING_BUDGET,
                    "include_thoughts": DEFAULT_INCLUDE_THOUGHTS,
                }
            }
        ),
        tools=raw_tools,
        tool_config=tool_config,
    )

    stream = await service._stream_content(params)
    usage_metadata = None
    prompt_feedback = None
    chunk_index = 0
    try:
        async for chunk in stream:
            chunk_index += 1
            if chunk.usage_metadata:
                usage_metadata = chunk.usage_metadata
            if chunk.prompt_feedback:
                prompt_feedback = chunk.prompt_feedback
            if not chunk.candidates:
                continue
            for candidate in chunk.candidates:
                print_candidate_parts(candidate)
    finally:
        await service.stop_ttfb_metrics()
        await service._client.aio.aclose()

    if chunk_index == 0:
        print("No output chunks received (empty stream).")
    if usage_metadata:
        print("--- Usage Metadata ---")
        print(usage_metadata)
    if prompt_feedback:
        print(f"Prompt feedback: {prompt_feedback}")


async def async_main() -> None:
    args = parse_args()
    api_key = resolve_api_key(args.api_key)
    invocation = load_invocation(args.invocation_path)
    await replay_with_service(invocation, args.model, api_key)


def main() -> None:
    try:
        asyncio.run(async_main())
    except KeyboardInterrupt:  # pragma: no cover
        print("Interrupted.", file=sys.stderr)
        sys.exit(130)


if __name__ == "__main__":
    main()
