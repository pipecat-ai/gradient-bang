"""Project-specific Gemini adapter customizations."""

from __future__ import annotations

from typing import List, Sequence

from google.genai.types import Content
from pipecat.adapters.services.gemini_adapter import GeminiLLMAdapter


class GradientBangGeminiLLMAdapter(GeminiLLMAdapter):
    """Disable cross-message tool-call merging for thinking mode.

    Pipecat's default Gemini adapter merges consecutive model tool-call messages
    into one message when thought signatures are present. That can produce
    context entries with multiple function calls in a single model message,
    which breaks our strict request/response sequencing assumptions.
    """

    def _merge_parallel_tool_calls_for_thinking(
        self, thought_signature_dicts: List[dict], messages: List[Content]
    ) -> List[Content]:
        return messages

    def _from_universal_context_messages(self, universal_context_messages):
        converted = super()._from_universal_context_messages(universal_context_messages)
        converted.messages = self._split_multi_function_call_model_messages(converted.messages)
        return converted

    @staticmethod
    def _split_multi_function_call_model_messages(messages: Sequence[Content]) -> List[Content]:
        """Normalize model tool calls to one function call per message.

        This enforces strict request/response sequencing in context by avoiding
        model messages with multiple function_call parts.
        """
        normalized: List[Content] = []
        for message in messages:
            parts = getattr(message, "parts", None)
            if getattr(message, "role", None) != "model" or not isinstance(parts, list):
                normalized.append(message)
                continue
            if len(parts) <= 1:
                normalized.append(message)
                continue
            if not all(getattr(part, "function_call", None) for part in parts):
                normalized.append(message)
                continue

            for part in parts:
                normalized.append(Content(role="model", parts=[part]))

        return normalized
