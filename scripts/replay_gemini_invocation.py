#!/usr/bin/env python3
"""Replay a logged Gemini invocation using the Google GenAI SDK."""

from __future__ import annotations

import argparse
import asyncio
import ast
import base64
import json
import os
import pickle
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

try:
    from google import genai  # type: ignore[import]
    from google.genai import types  # type: ignore[import]
except ImportError as exc:  # pragma: no cover - runtime dependency
    raise SystemExit(
        "The google-genai package is required. Install with `uv add google-genai`."
    ) from exc

from pydantic import ValidationError

DEFAULT_GOOGLE_MODEL = "gemini-2.5-flash-preview-09-2025"
# DEFAULT_GOOGLE_MODEL = "gemini-2.5-pro-preview-06-05"
DEFAULT_THINKING_BUDGET = 2048
DEFAULT_INCLUDE_THOUGHTS = True
TURN_TIMEOUT_SECONDS = 30
DEFAULT_MAX_OUTPUT_TOKENS = 4096


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Replay a Gemini request that was logged in the `full-run.json` format "
            "and print the output chunks."
        )
    )
    parser.add_argument(
        "invocation_path",
        nargs="?",
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
    parser.add_argument(
        "--show-metadata",
        action="store_true",
        help="Print usage metadata after the response.",
    )
    parser.add_argument(
        "--pickle",
        dest="pickle_path",
        nargs="?",
        type=Path,
        const=Path("logs/google_llm_service_request.pkl"),
        help=(
            "Replay a pickled invocation captured from GoogleLLMService (default path: "
            "logs/google_llm_service_request.pkl)."
        ),
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

    messages = invocation.get("messages")
    if not isinstance(messages, list) or not messages:
        raise SystemExit(
            "Invocation payload is missing 'messages'; expected a non-empty list."
        )

    return invocation


def build_generation_config(
    system_instruction: Optional[Any],
    tools: Optional[List[Dict[str, Any]]] = None,
    tool_config: Optional[Dict[str, Any]] = None,
) -> Tuple[types.GenerateContentConfig, Dict[str, Any]]:
    normalized_instruction = normalize_system_instruction(system_instruction)

    generation_params: Dict[str, Any] = {
        "system_instruction": normalized_instruction,
        "max_output_tokens": DEFAULT_MAX_OUTPUT_TOKENS,
        "temperature": None,
        "top_p": None,
        "top_k": None,
        "thinking_config": {
            "thinking_budget": DEFAULT_THINKING_BUDGET,
            "include_thoughts": DEFAULT_INCLUDE_THOUGHTS,
        },
    }
    if tools:
        generation_params["tools"] = tools
    if tool_config:
        generation_params["tool_config"] = tool_config

    filtered_params = {k: v for k, v in generation_params.items() if v is not None}
    config = types.GenerateContentConfig(**filtered_params)
    return config, filtered_params


def _part_label_and_text(part: Any) -> Tuple[str, str]:
    text = getattr(part, "text", None)
    if text:
        return ("text", text)

    thought = getattr(part, "thought", None)
    if thought:
        return ("thought", thought)

    function_call = getattr(part, "function_call", None)
    if function_call:
        name = getattr(function_call, "name", "unknown_function")
        args = getattr(function_call, "args", None)
        return (
            "function_call",
            json.dumps({"name": name, "args": args}, ensure_ascii=False),
        )

    function_response = getattr(part, "function_response", None)
    if function_response:
        name = getattr(function_response, "name", "unknown_function")
        response = getattr(function_response, "response", None)
        return (
            "function_response",
            json.dumps({"name": name, "response": response}, ensure_ascii=False),
        )

    code_result = getattr(part, "code_execution_result", None)
    if code_result:
        return ("code_execution_result", json.dumps(code_result, ensure_ascii=False))

    inline_data = getattr(part, "inline_data", None)
    if inline_data:
        return ("inline_data", json.dumps(inline_data, ensure_ascii=False))

    return ("part", str(part))


def print_candidate_parts(candidate: Any) -> None:
    content = getattr(candidate, "content", None)
    raw_parts = getattr(content, "parts", None) if content else None
    parts: Iterable[Any] = raw_parts or []
    for index, part in enumerate(parts):
        label, value = _part_label_and_text(part)
        print(f"[chunk {index}][{label}] {value}")
    if not parts:
        function_call = getattr(candidate, "function_call", None)
        if function_call:
            name = getattr(function_call, "name", "unknown_function")
            args = getattr(function_call, "args", None)
            print(f"[function_call] {name} {args}")


def _sanitize_part(part: Any) -> Any:
    if not isinstance(part, dict):
        return part

    sanitized: Dict[str, Any] = {}
    for key, value in part.items():
        if value is None:
            continue
        if key == "thought_signature" and isinstance(value, str):
            sanitized[key] = _sanitize_thought_signature(value)
        else:
            sanitized[key] = value
    return sanitized


def _sanitize_thought_signature(value: str) -> str:
    stripped = value.strip()
    if not stripped:
        return stripped

    if (stripped.startswith("b'") and stripped.endswith("'")) or (
        stripped.startswith('b"') and stripped.endswith('"')
    ):
        try:
            literal = ast.literal_eval(stripped)
            if isinstance(literal, bytes):
                return base64.b64encode(literal).decode("ascii")
        except (SyntaxError, ValueError):
            pass

    return stripped


def _sanitize_content_dict(content: Dict[str, Any]) -> Dict[str, Any]:
    sanitized: Dict[str, Any] = {
        key: value for key, value in content.items() if value is not None
    }

    parts = sanitized.get("parts")
    if isinstance(parts, list):
        sanitized_parts: List[Any] = []
        for part in parts:
            sanitized_parts.append(_sanitize_part(part))
        sanitized["parts"] = sanitized_parts

    return sanitized


def _prune_none(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _prune_none(subvalue)
            for key, subvalue in value.items()
            if subvalue is not None
        }
    if isinstance(value, list):
        return [_prune_none(item) for item in value]
    return value


def _ensure_content_list(messages: List[Any]) -> List[types.Content]:
    normalized: List[types.Content] = []
    for index, message in enumerate(messages):
        if isinstance(message, types.Content):
            normalized.append(message)
        elif isinstance(message, dict):
            try:
                normalized.append(types.Content.model_validate(message))
            except ValidationError as exc:
                raise SystemExit(
                    f"Failed to parse message #{index} from pickle into Content: {exc}"
                ) from exc
        else:
            raise SystemExit(
                f"Unsupported message type at index {index}: {type(message).__name__}"
            )
    return normalized


def _dump_replay_request(
    model: str,
    contents: List[types.Content],
    config: Optional[types.GenerateContentConfig],
    generation_params: Dict[str, Any],
    tools: Optional[Any],
    tool_config: Optional[Any],
) -> None:
    dump_payload = {
        "model": model,
        "contents": contents,
        "generation_config": config,
        "generation_params": generation_params,
        "tools": tools,
        "tool_config": tool_config,
        "messages_json": [
            message.to_json_dict() if hasattr(message, "to_json_dict") else message
            for message in contents
        ],
        "config_json": (
            config.model_dump(mode="json") if config else None
        ),
    }
    dump_path = Path("logs/replay_generate_content_stream.pkl")
    dump_path.parent.mkdir(parents=True, exist_ok=True)
    with dump_path.open("wb") as handle:
        pickle.dump(dump_payload, handle)


def normalize_tools(raw_tools: Any) -> Optional[List[Dict[str, Any]]]:
    if not raw_tools:
        return None

    if isinstance(raw_tools, list):
        normalized_tools: List[Dict[str, Any]] = []
        for index, tool in enumerate(raw_tools):
            if isinstance(tool, dict):
                normalized_tools.append(_prune_none(tool))
                continue
            if hasattr(tool, "model_dump"):
                normalized_tools.append(_prune_none(tool.model_dump(mode="json")))
                continue
            raise SystemExit(
                f"Unsupported tool type at index {index}: {type(tool).__name__}"
            )
        return normalized_tools

    raise SystemExit(f"Unsupported tools payload type: {type(raw_tools).__name__}")


def normalize_tool_config(raw_tool_config: Any) -> Optional[Dict[str, Any]]:
    if raw_tool_config in (None, {}, []):
        return None
    if isinstance(raw_tool_config, dict):
        return _prune_none(raw_tool_config)
    if hasattr(raw_tool_config, "model_dump"):
        return _prune_none(raw_tool_config.model_dump(mode="json"))
    raise SystemExit(
        f"Unsupported tool_config type: {type(raw_tool_config).__name__}"
    )


def normalize_messages(messages: List[Any]) -> List[types.Content]:
    normalized: List[types.Content] = []
    for index, message in enumerate(messages):
        if isinstance(message, types.Content):
            normalized.append(message)
            continue

        if isinstance(message, dict):
            message = _sanitize_content_dict(message)
            try:
                normalized.append(types.Content.model_validate(message))
                continue
            except ValidationError as exc:
                raise SystemExit(
                    f"Failed to parse message #{index} into Content: {exc}"
                ) from exc

        raise SystemExit(
            f"Unsupported message type at index {index}: {type(message).__name__}"
        )

    return normalized


async def replay_invocation(
    invocation: Dict[str, Any],
    model: str,
    api_key: str,
    show_metadata: bool,
) -> None:
    system_instruction = invocation.get("system_instruction")
    messages = normalize_messages(invocation.get("messages", []))
    tools = normalize_tools(invocation.get("tools"))
    tool_config = normalize_tool_config(invocation.get("tool_config"))

    generation_config, generation_params = build_generation_config(
        system_instruction, tools, tool_config
    )

    _dump_replay_request(model, messages, generation_config, generation_params, tools, tool_config)

    client = genai.Client(api_key=api_key)
    async with client.aio as aclient:
        response = await aclient.models.generate_content_stream(
            model=model,
            contents=messages,
            config=generation_config,
        )
        await _emit_response(response, show_metadata)


def load_pickled_payload(path: Path) -> Dict[str, Any]:
    if not path.exists():
        raise SystemExit(f"Pickle file not found: {path}")
    with path.open("rb") as handle:
        return pickle.load(handle)


async def replay_pickled(
    payload: Dict[str, Any],
    cli_model: str,
    api_key: str,
    show_metadata: bool,
) -> None:
    contents = payload.get("contents") or payload.get("messages")
    if contents is None and payload.get("messages_json"):
        contents = payload["messages_json"]
    if contents is None:
        raise SystemExit("Pickled payload is missing 'contents' or 'messages'.")
    messages = _ensure_content_list(list(contents))

    generation_config = payload.get("generation_config")
    if isinstance(generation_config, dict):
        generation_config = types.GenerateContentConfig.model_validate(generation_config)
    generation_params = payload.get("generation_params", {})
    if generation_config is None and generation_params:
        generation_config = types.GenerateContentConfig(**generation_params)

    tools = payload.get("tools")
    tool_config = payload.get("tool_config")

    payload_model = payload.get("model")
    if payload_model and payload_model != cli_model:
        model_name = payload_model
    else:
        model_name = payload_model or cli_model

    # If generation_config was None and generation_params empty, ensure dump reflects that
    if generation_config is None:
        generation_params = {}

    _dump_replay_request(
        model_name, messages, generation_config, generation_params, tools, tool_config
    )

    client = genai.Client(api_key=api_key)
    async with client.aio as aclient:
        response = await aclient.models.generate_content_stream(
            model=model_name,
            contents=messages,
            config=generation_config,
        )
        await _emit_response(response, show_metadata)


async def _emit_response(response: Any, show_metadata: bool) -> None:
    if hasattr(response, "__aiter__"):
        chunk_index = 0
        usage_metadata = None
        prompt_feedback = None
        async for chunk in response:  # pragma: no cover - streaming path
            candidates = getattr(chunk, "candidates", [])
            for candidate in candidates:
                print_candidate_parts(candidate)
            chunk_index += 1
            chunk_usage = getattr(chunk, "usage_metadata", None)
            if chunk_usage is not None:
                usage_metadata = chunk_usage
            chunk_feedback = getattr(chunk, "prompt_feedback", None)
            if chunk_feedback is not None:
                prompt_feedback = chunk_feedback
        if chunk_index == 0:
            print("No output chunks received (empty stream).")
            if show_metadata and prompt_feedback:
                print(f"Prompt feedback: {prompt_feedback}")
            return
        if show_metadata:
            if usage_metadata:
                print("--- Usage Metadata ---")
                print(usage_metadata)
            if prompt_feedback:
                print(f"Prompt feedback: {prompt_feedback}")
        return

    candidates = getattr(response, "candidates", [])
    if not candidates:
        finish_reason = getattr(response, "prompt_feedback", None)
        print("No candidates returned.")
        if finish_reason:
            print(f"Prompt feedback: {finish_reason}")
    for candidate_index, candidate in enumerate(candidates):
        finish_reason = getattr(candidate, "finish_reason", None)
        if finish_reason:
            print(
                f"=== Candidate {candidate_index} (finish_reason={finish_reason}) ==="
            )
        else:
            print(f"=== Candidate {candidate_index} ===")
        print_candidate_parts(candidate)

    if show_metadata:
        usage = getattr(response, "usage_metadata", None)
        if usage:
            print("--- Usage Metadata ---")
            print(usage)


def _parts_to_text(parts: Iterable[Any]) -> str:
    fragments: List[str] = []
    for part in parts:
        if hasattr(part, "text") and getattr(part, "text"):
            fragments.append(getattr(part, "text"))
        elif isinstance(part, dict) and part.get("text"):
            fragments.append(part.get("text", ""))
    return "".join(fragments)


def normalize_system_instruction(
    instruction: Optional[Any],
) -> Optional[str]:
    if instruction is None or instruction == "":
        return None

    if isinstance(instruction, types.Content):
        text = _parts_to_text(getattr(instruction, "parts", []))
        if text:
            return text
        raise SystemExit("System instruction Content does not contain text.")

    if isinstance(instruction, dict):
        instruction = _sanitize_content_dict(instruction)
        parts = instruction.get("parts")
        if isinstance(parts, list):
            text = _parts_to_text(parts)
            if text:
                return text
        text_value = instruction.get("text")
        if isinstance(text_value, str):
            return text_value
        return "; ".join(
            f"{key}={value}" for key, value in instruction.items() if isinstance(value, str)
        ) or None

    if isinstance(instruction, str):
        return instruction

    raise SystemExit(
        f"Unsupported system_instruction type: {type(instruction).__name__}"
    )


async def async_main() -> None:
    args = parse_args()
    api_key = resolve_api_key(args.api_key)
    if args.pickle_path:
        payload = load_pickled_payload(args.pickle_path)
        await replay_pickled(payload, args.model, api_key, args.show_metadata)
        return
    if not args.invocation_path:
        raise SystemExit("Provide an invocation JSON path or use --pickle.")
    invocation = load_invocation(args.invocation_path)
    await replay_invocation(invocation, args.model, api_key, args.show_metadata)


def main() -> None:
    try:
        asyncio.run(async_main())
    except KeyboardInterrupt:  # pragma: no cover - CLI convenience
        print("Interrupted.", file=sys.stderr)
        sys.exit(130)


if __name__ == "__main__":
    main()
