"""OpenAI Responses API LLM service for Pipecat.

Uses OpenAI's Responses API instead of Chat Completions to support streaming
reasoning/thinking summaries as LLMThoughtTextFrame.

The Responses API provides:
- Streaming reasoning summary text (response.reasoning_summary_text.delta)
- Function calling with streaming argument deltas
- Token usage in the completed response event
"""

from __future__ import annotations

import json
import time
from typing import Any, Dict, List, Optional

from loguru import logger
from openai import NOT_GIVEN, AsyncOpenAI

from pipecat.frames.frames import (
    LLMTextFrame,
    LLMThoughtEndFrame,
    LLMThoughtStartFrame,
    LLMThoughtTextFrame,
)
from pipecat.metrics.metrics import LLMTokenUsage
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.openai_llm_context import OpenAILLMContext
from pipecat.services.llm_service import FunctionCallFromLLM
from pipecat.services.openai.base_llm import BaseOpenAILLMService


class OpenAIResponsesLLMService(BaseOpenAILLMService):
    """OpenAI LLM service using the Responses API for reasoning/thinking support.

    Subclasses BaseOpenAILLMService, replacing _process_context to use the
    Responses API. This enables streaming reasoning summary text which is
    emitted as LLMThoughtTextFrame for downstream consumers.

    The service converts Chat Completions-format messages (from the universal
    LLMContext) into Responses API input format on each call.
    """

    def __init__(
        self,
        *,
        model: str,
        reasoning_effort: str = "medium",
        reasoning_summary: str = "detailed",
        **kwargs,
    ):
        super().__init__(model=model, **kwargs)
        self._responses_model = model
        self._reasoning_effort = reasoning_effort
        self._reasoning_summary = reasoning_summary

    # ── Message format conversion ────────────────────────────────────────

    @staticmethod
    def _convert_messages_to_responses_input(
        messages: List[Dict[str, Any]],
    ) -> tuple[Optional[str], List[Dict[str, Any]]]:
        """Convert Chat Completions messages to Responses API input format.

        Returns (instructions, input_items) where instructions is the system
        prompt (or None) and input_items is the list of Responses API input items.
        """
        instructions = None
        input_items: List[Dict[str, Any]] = []

        for msg in messages:
            role = msg.get("role")
            content = msg.get("content")

            if role == "system" or role == "developer":
                if isinstance(content, str):
                    instructions = (
                        f"{instructions}\n\n{content}" if instructions else content
                    )
                continue

            if role == "user":
                if isinstance(content, str):
                    input_items.append({"role": "user", "content": content})
                elif isinstance(content, list):
                    # Multi-part content (text + images) — pass through
                    input_items.append({"role": "user", "content": content})
                continue

            if role == "assistant":
                # Assistant text content
                if content:
                    input_items.append(
                        {
                            "type": "message",
                            "role": "assistant",
                            "content": [
                                {"type": "output_text", "text": content}
                            ],
                        }
                    )
                # Tool calls become separate function_call input items
                for tc in msg.get("tool_calls", []):
                    func = tc.get("function", {})
                    input_items.append(
                        {
                            "type": "function_call",
                            "name": func.get("name", ""),
                            "arguments": func.get("arguments", "{}"),
                            "call_id": tc.get("id", ""),
                        }
                    )
                continue

            if role == "tool":
                tool_content = content if isinstance(content, str) else json.dumps(content)
                input_items.append(
                    {
                        "type": "function_call_output",
                        "call_id": msg.get("tool_call_id", ""),
                        "output": tool_content,
                    }
                )
                continue

        return instructions, input_items

    @staticmethod
    def _convert_tools_to_responses_format(
        tools: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Convert Chat Completions tool definitions to Responses API format.

        Chat Completions: {"type": "function", "function": {"name": ..., "parameters": ..., "description": ...}}
        Responses API:    {"type": "function", "name": ..., "parameters": ..., "description": ...}
        """
        response_tools = []
        for tool in tools:
            if tool.get("type") == "function":
                func = tool.get("function", {})
                resp_tool: Dict[str, Any] = {
                    "type": "function",
                    "name": func.get("name", ""),
                    "parameters": func.get("parameters", {}),
                }
                if "description" in func:
                    resp_tool["description"] = func["description"]
                if "strict" in func:
                    resp_tool["strict"] = func["strict"]
                response_tools.append(resp_tool)
        return response_tools

    # ── Core inference using Responses API ───────────────────────────────

    async def _process_context(self, context: OpenAILLMContext | LLMContext):
        """Process LLM context using the Responses API with streaming.

        Converts messages and tools from Chat Completions format, calls the
        Responses API, and emits appropriate pipecat frames for reasoning
        summary text, output text, and function calls.
        """
        # Extract messages and tools from context
        t_prep_start = time.perf_counter()
        if isinstance(context, OpenAILLMContext):
            messages = context.get_messages()
            tools_list = context.tools if context.tools else []
        else:
            adapter = self.get_llm_adapter()
            params = adapter.get_llm_invocation_params(context, convert_developer_to_user=False)
            messages = params.get("messages", [])
            tools_list = params.get("tools", [])

        # Convert to Responses API format
        instructions, input_items = self._convert_messages_to_responses_input(messages)
        response_tools = self._convert_tools_to_responses_format(tools_list)
        t_prep_elapsed = time.perf_counter() - t_prep_start
        if t_prep_elapsed > 0.05:
            logger.warning(
                "OpenAI Responses API: context preparation took {:.3f}s "
                "(messages={}, tools={})",
                t_prep_elapsed,
                len(messages),
                len(tools_list),
            )

        # Build API call params
        reasoning_config = {
            "effort": self._reasoning_effort,
            "summary": self._reasoning_summary,
        }

        api_kwargs: Dict[str, Any] = {
            "model": self._responses_model,
            "input": input_items,
            "stream": True,
            "reasoning": reasoning_config,
        }

        if instructions:
            api_kwargs["instructions"] = instructions
        if response_tools:
            api_kwargs["tools"] = response_tools
            # Don't force parallel tool calls — let the model decide
            api_kwargs["parallel_tool_calls"] = False

        # Pass through applicable settings.
        # _settings may be a dict (pipecat <=0.0.103) or an object (newer).
        def _get_setting(key):
            if isinstance(self._settings, dict):
                return self._settings.get(key)
            return getattr(self._settings, key, None)

        temp = _get_setting("temperature")
        if temp is not None and temp is not NOT_GIVEN:
            api_kwargs["temperature"] = temp
        top_p = _get_setting("top_p")
        if top_p is not None and top_p is not NOT_GIVEN:
            api_kwargs["top_p"] = top_p
        max_tokens = _get_setting("max_completion_tokens")
        if max_tokens is not None and max_tokens is not NOT_GIVEN:
            api_kwargs["max_output_tokens"] = max_tokens

        # Timing
        t_start = time.perf_counter()
        t_first_thinking = None
        t_first_content = None
        t_first_function = None
        in_thinking = False

        await self.start_ttfb_metrics()

        # Track function calls: item_id -> {name, arguments, call_id}
        function_calls: Dict[str, Dict[str, str]] = {}

        # Estimate request payload size for diagnostics
        instructions_len = len(instructions) if instructions else 0
        input_chars = sum(
            len(json.dumps(item)) for item in input_items
        )
        logger.info(
            "OpenAI Responses API: starting inference, model={}, reasoning_effort={}, "
            "reasoning_summary={}, tools={}, input_items={}, "
            "instructions_chars={}, input_chars={}",
            self._responses_model,
            self._reasoning_effort,
            self._reasoning_summary,
            len(response_tools),
            len(input_items),
            instructions_len,
            input_chars,
        )

        try:
            stream = await self._client.responses.create(**api_kwargs)
            t_stream_opened = time.perf_counter()
            logger.info(
                "OpenAI Responses API: stream opened in {:.3f}s, waiting for first event",
                t_stream_opened - t_start,
            )

            t_first_event = None
            async for event in stream:
                if t_first_event is None:
                    t_first_event = time.perf_counter()
                    logger.info(
                        "OpenAI Responses API: first stream event at {:.3f}s (type={}), "
                        "stream_wait={:.3f}s",
                        t_first_event - t_start,
                        event.type,
                        t_first_event - t_stream_opened,
                    )
                event_type = event.type

                # ── Reasoning summary text (thinking) ────────────────
                if event_type == "response.reasoning_summary_text.delta":
                    if not in_thinking:
                        in_thinking = True
                        await self.push_frame(LLMThoughtStartFrame())
                    if t_first_thinking is None:
                        t_first_thinking = time.perf_counter()
                        await self.stop_ttfb_metrics()
                        logger.info(
                            "OpenAI Responses API: first thinking token at {:.3f}s",
                            t_first_thinking - t_start,
                        )
                    await self.push_frame(LLMThoughtTextFrame(text=event.delta))

                elif event_type == "response.reasoning_summary_text.done":
                    if in_thinking:
                        in_thinking = False
                        await self.push_frame(LLMThoughtEndFrame())
                        logger.info(
                            "OpenAI Responses API: thinking done at {:.3f}s",
                            time.perf_counter() - t_start,
                        )

                # ── Output text ──────────────────────────────────────
                elif event_type == "response.output_text.delta":
                    if in_thinking:
                        in_thinking = False
                        await self.push_frame(LLMThoughtEndFrame())
                    if t_first_content is None:
                        t_first_content = time.perf_counter()
                        await self.stop_ttfb_metrics()
                        logger.info(
                            "OpenAI Responses API: first content token at {:.3f}s",
                            t_first_content - t_start,
                        )
                    await self._push_llm_text(event.delta)

                # ── Function calls ───────────────────────────────────
                elif event_type == "response.output_item.added":
                    item = event.item
                    if hasattr(item, "type") and item.type == "function_call":
                        if in_thinking:
                            in_thinking = False
                            await self.push_frame(LLMThoughtEndFrame())
                        if t_first_function is None:
                            t_first_function = time.perf_counter()
                            await self.stop_ttfb_metrics()
                            logger.info(
                                "OpenAI Responses API: first function call at {:.3f}s, name={}",
                                t_first_function - t_start,
                                getattr(item, "name", "?"),
                            )
                        function_calls[item.id] = {
                            "name": getattr(item, "name", ""),
                            "arguments": "",
                            "call_id": getattr(item, "call_id", item.id),
                        }

                elif event_type == "response.function_call_arguments.delta":
                    item_id = event.item_id
                    if item_id in function_calls:
                        function_calls[item_id]["arguments"] += event.delta

                elif event_type == "response.function_call_arguments.done":
                    item_id = event.item_id
                    if item_id in function_calls:
                        function_calls[item_id]["arguments"] = event.arguments

                # ── Completed — extract usage ────────────────────────
                elif event_type == "response.completed":
                    resp = event.response
                    if resp and resp.usage:
                        usage = resp.usage
                        tokens = LLMTokenUsage(
                            prompt_tokens=usage.input_tokens,
                            completion_tokens=usage.output_tokens,
                            total_tokens=usage.total_tokens,
                        )
                        await self.start_llm_usage_metrics(tokens)

                    if resp and resp.model and self.get_full_model_name() != resp.model:
                        self.set_full_model_name(resp.model)

        except Exception:
            # Close thinking frame if still open
            if in_thinking:
                await self.push_frame(LLMThoughtEndFrame())
            raise

        t_end = time.perf_counter()
        logger.info(
            "OpenAI Responses API: inference complete in {:.3f}s "
            "(thinking: {}, content: {}, function_calls: {})",
            t_end - t_start,
            f"{t_first_thinking - t_start:.3f}s" if t_first_thinking else "none",
            f"{t_first_content - t_start:.3f}s" if t_first_content else "none",
            len(function_calls),
        )

        # Dispatch accumulated function calls
        if function_calls:
            calls = []
            for item_id, fc in function_calls.items():
                if fc["name"] and fc["arguments"]:
                    try:
                        arguments = json.loads(fc["arguments"])
                    except json.JSONDecodeError:
                        logger.warning(
                            "OpenAI Responses API: failed to parse arguments for {}: {}",
                            fc["name"],
                            fc["arguments"][:200],
                        )
                        continue
                    calls.append(
                        FunctionCallFromLLM(
                            context=context,
                            tool_call_id=fc["call_id"],
                            function_name=fc["name"],
                            arguments=arguments,
                        )
                    )
            if calls:
                await self.run_function_calls(calls)
