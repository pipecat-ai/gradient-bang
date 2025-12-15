"""Custom frame types for Gradient Bang voice pipeline."""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from pipecat.frames.frames import DataFrame

if TYPE_CHECKING:
    from pipecat.processors.aggregators.llm_context import LLMContext


@dataclass
class GradientBangContextCompressionFrame(DataFrame):
    """Frame containing compressed context data to be applied to the conversation.

    Attributes:
        context: Reference to the LLMContext to modify (required because consumer
                 may not see LLMContextFrame - the LLM consumes it before the consumer)
        compressed_summary: The compressed summary text to replace old messages
        original_messages_count: Number of messages in the original context when
                                 compression started (used to preserve newer messages)
        trigger_reason: What triggered compression ("threshold" or "explicit_request")
        compression_duration_ms: Time taken to run compression LLM call
        original_approx_tokens: Approximate token count before compression
        compressed_approx_tokens: Approximate token count after compression
        timestamp: When compression was triggered
    """

    context: "LLMContext"
    compressed_summary: str
    original_messages_count: int
    trigger_reason: str  # "threshold" or "explicit_request"
    compression_duration_ms: float
    original_approx_tokens: int
    compressed_approx_tokens: int
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
