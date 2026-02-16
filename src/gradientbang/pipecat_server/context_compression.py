"""Context compression for long-running voice conversations.

This module provides a Producer/Consumer pair for asynchronously compressing
the LLM context when it grows too large or when the user explicitly requests it.

The Producer monitors LLMContextFrame and triggers compression when needed.
The Consumer receives the compressed result and applies it to the shared context.
"""

import asyncio
import time
from datetime import datetime, timezone
from typing import Optional

from google import genai
from google.genai.types import Content, GenerateContentConfig, Part
from loguru import logger
from pipecat.frames.frames import CancelFrame, EndFrame, Frame, LLMContextFrame, StartFrame, SystemFrame
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.consumer_processor import ConsumerProcessor
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.processors.producer_processor import ProducerProcessor

from gradientbang.utils.gemini_adapter import GradientBangGeminiLLMAdapter

from .frames import GradientBangContextCompressionFrame

# Timeout for compression API calls (prevents hanging forever)
COMPRESSION_TIMEOUT_SECONDS = 120

# System prompt for detecting explicit compression requests
COMPRESSION_INTENT_SYSTEM_PROMPT = """You are analyzing a conversation to determine if the USER (human player) is explicitly requesting to compress or reset the AI's conversation memory.

ONLY trigger on DIRECT user requests to manage the AI's memory/context, such as:
- "compress the context"
- "compress your memory"
- "clear your memory"
- "reset your memory"
- "forget everything except..."
- "start fresh but remember..."
- "condense this conversation"
- "your context is getting too long"

DO NOT trigger on:
- Task completion messages like "Task completed. Please summarize what was accomplished."
- Requests to summarize game events, missions, or accomplishments
- System-generated messages (anything in <task_progress>, <event>, or similar tags)
- The AI assistant summarizing its own actions
- General conversation about the game

The request must be the USER asking to manage the AI's MEMORY or CONTEXT specifically.

Respond with ONLY the single word "yes" or "no".
- "yes" = the user is explicitly asking to compress/reset the AI's conversation memory
- "no" = NOT a memory compression request
"""

# System prompt for the actual compression
COMPRESSION_SYSTEM_PROMPT = """Compress this game session conversation into a HIGH-LEVEL summary of major accomplishments.

RULES:
- Produce AT MOST 5-6 summary blocks total
- Each summary covers a MAJOR MISSION or STORY ARC, not individual actions
- Group related actions together into narrative arcs
- Focus on OUTCOMES and RESULTS: what was accomplished, key rewards earned, important items acquired
- Omit routine navigation, status checks, and minor details

FORMAT: <summary timestamp=ISO_TIMESTAMP>High-level description of mission/arc completion</summary>

BAD (too granular):
<summary>Bought iron ore</summary>
<summary>Set course for Sector 31</summary>
<summary>Launched ship</summary>
<summary>Arrived at Sector 31</summary>
<summary>Sold iron ore</summary>

GOOD (narrative arc):
<summary timestamp=2024-01-15T10:30:00Z>Completed trading run from Nova Station to Research Station Kepler, earning 19,100 credits profit from medical supplies and platinum sales.</summary>

Include all previous <summary></summary> blocks unchanged in your output, then add new summaries for activity since the last summary."""


class ContextCompressionProducer(ProducerProcessor):
    """Producer that monitors LLM context and produces compression frames.

    This processor sits in a parallel branch, monitors LLMContextFrame for
    compression triggers, and produces GradientBangContextCompressionFrame
    when compression completes. It acts as a sink - no frames pass through.

    The LLMContext reference is cached from incoming LLMContextFrame objects,
    so it does not need to be passed to the constructor.
    """

    # Minimum messages required after last <summary> block before re-compression
    MIN_MESSAGES_AFTER_SUMMARY = 5

    def __init__(
        self,
        api_key: str,
        message_threshold: int = 200,
        model: str = "gemini-2.5-flash",
    ):
        """Initialize the compression producer.

        Args:
            api_key: Google API key for Gemini calls
            message_threshold: Number of messages that triggers automatic compression
            model: Gemini model to use for compression
        """
        # Initialize with never-matching filter since we produce manually
        super().__init__(
            filter=self._never_match,
            passthrough=False,
        )
        self._api_key = api_key
        self._message_threshold = message_threshold
        self._model = model
        self._client = genai.Client(api_key=api_key)
        self._adapter = GradientBangGeminiLLMAdapter()  # Use game-specific Gemini conversion rules
        self._compression_lock = asyncio.Lock()  # Prevents race conditions
        self._compression_in_progress = False
        self._context: Optional[LLMContext] = None  # Cached from LLMContextFrame

    async def _never_match(self, frame: Frame) -> bool:
        """Filter that never matches - we produce manually."""
        return False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        """Process frames, monitoring for compression triggers.

        Overrides ProducerProcessor.process_frame to act as a sink for data frames
        while passing through system frames (StartFrame, EndFrame, etc.) which are
        required for pipeline initialization and shutdown.
        """
        # Call FrameProcessor.process_frame directly, skipping ProducerProcessor's
        # default produce/passthrough logic
        await FrameProcessor.process_frame(self, frame, direction)

        # Only forward lifecycle system frames so side branches don't short-circuit
        # transport-bound messages (e.g., bot-ready) in the ParallelPipeline.
        if isinstance(frame, SystemFrame):
            if isinstance(frame, (StartFrame, EndFrame, CancelFrame)):
                await self.push_frame(frame, direction)
            return

        # Only process LLMContextFrames, sink all other data frames
        if not isinstance(frame, LLMContextFrame):
            return  # Sink - don't push

        # Cache the context reference
        self._context = frame.context
        messages = frame.context.messages

        # Use lock to prevent race conditions between check and start
        # Try to acquire without blocking - if locked, another check is in progress
        if not self._compression_lock.locked():
            async with self._compression_lock:
                # Double-check after acquiring lock
                if self._compression_in_progress:
                    return

                # Check cooldown: need at least MIN_MESSAGES_AFTER_SUMMARY after last <summary>
                if not self._cooldown_satisfied(messages):
                    return

                # Check if compression is needed
                trigger_reason = await self._check_compression_needed(messages)
                if trigger_reason:
                    self._compression_in_progress = True
                    messages_count = len(messages)
                    self.create_task(
                        self._run_compression(list(messages), messages_count, trigger_reason)
                    )

        # Don't push frame - this is a sink

    def _cooldown_satisfied(self, messages: list) -> bool:
        """Check if enough messages have been added since last compression.

        Returns True if:
        - No <summary> blocks exist (never compressed), OR
        - At least MIN_MESSAGES_AFTER_SUMMARY messages exist after the last <summary> block
        """
        last_summary_index = self._find_last_summary_index(messages)

        if last_summary_index == -1:
            # No previous compression, cooldown satisfied
            return True

        messages_after_summary = len(messages) - last_summary_index - 1
        return messages_after_summary >= self.MIN_MESSAGES_AFTER_SUMMARY

    def _find_last_summary_index(self, messages: list) -> int:
        """Find the index of the last message containing <summary> blocks.

        Returns -1 if no summary blocks found.
        """
        for i in range(len(messages) - 1, -1, -1):
            msg = messages[i]
            content = msg.get("content", "") if isinstance(msg, dict) else ""
            if isinstance(content, str) and "<summary" in content:
                return i
        return -1

    async def _check_compression_needed(self, messages: list) -> Optional[str]:
        """Check if compression should be triggered.

        Returns trigger reason string if compression needed, None otherwise.
        """
        # Check message count first
        if len(messages) > self._message_threshold:
            logger.info(
                f"Compression triggered: message count {len(messages)} > {self._message_threshold}"
            )
            return "threshold"

        # Check for explicit user request
        if await self._check_explicit_request(messages):
            return "explicit_request"

        return None

    async def _check_explicit_request(self, messages: list) -> bool:
        """Check if user explicitly requested compression."""
        recent_messages = self._extract_recent_exchanges(messages, count=3)
        if not recent_messages:
            return False

        try:
            response = await self._client.aio.models.generate_content(
                model=self._model,
                contents=recent_messages,
                config=GenerateContentConfig(
                    system_instruction=COMPRESSION_INTENT_SYSTEM_PROMPT
                ),
            )
            result = self._extract_text(response).strip().lower()
            if result == "yes":
                logger.info("Compression triggered: explicit user request detected")
                return True
            return False
        except Exception as e:
            logger.warning(f"Failed to check explicit compression request: {e}")
            return False

    async def _run_compression(
        self, messages: list, original_count: int, trigger_reason: str
    ):
        """Run the compression LLM call and produce the result frame."""
        start_time = time.time()
        timestamp = datetime.now(timezone.utc)

        # Calculate approximate tokens before compression
        original_approx_tokens = self._estimate_tokens(messages)

        try:
            logger.info(f"Starting context compression for {original_count} messages")

            # Prepare messages for compression (exclude system messages)
            compression_messages = self._prepare_compression_messages(messages)

            # Add timeout to prevent hanging forever
            try:
                response = await asyncio.wait_for(
                    self._client.aio.models.generate_content(
                        model=self._model,
                        contents=compression_messages,
                        config=GenerateContentConfig(
                            system_instruction=COMPRESSION_SYSTEM_PROMPT
                        ),
                    ),
                    timeout=COMPRESSION_TIMEOUT_SECONDS,
                )
            except asyncio.TimeoutError:
                raise TimeoutError(
                    f"Compression API call timed out after {COMPRESSION_TIMEOUT_SECONDS}s"
                )

            compressed_summary = self._extract_text(response)
            duration_ms = (time.time() - start_time) * 1000

            if not compressed_summary:
                logger.warning("Compression returned empty result, creating failure block")
                compressed_summary = self._create_failure_block(
                    "Compression returned empty result", timestamp
                )

            # Calculate approximate tokens after compression
            compressed_approx_tokens = self._estimate_tokens_from_text(compressed_summary)

            # Produce the compression frame to consumers
            frame = GradientBangContextCompressionFrame(
                context=self._context,  # Pass context reference for consumer to modify
                compressed_summary=compressed_summary,
                original_messages_count=original_count,
                trigger_reason=trigger_reason,
                compression_duration_ms=duration_ms,
                original_approx_tokens=original_approx_tokens,
                compressed_approx_tokens=compressed_approx_tokens,
                timestamp=timestamp,
            )
            await self._produce(frame)

            logger.info(
                f"Compression complete: {original_count} messages ({original_approx_tokens} tokens) "
                f"-> {compressed_approx_tokens} tokens in {duration_ms:.0f}ms "
                f"[trigger: {trigger_reason}]"
            )

        except Exception as e:
            duration_ms = (time.time() - start_time) * 1000
            logger.warning(f"Compression failed after {duration_ms:.0f}ms: {e}")

            # Create failure block
            compressed_summary = self._create_failure_block(str(e), timestamp)
            compressed_approx_tokens = self._estimate_tokens_from_text(compressed_summary)

            # Still produce a frame so cooldown is respected
            frame = GradientBangContextCompressionFrame(
                context=self._context,  # Pass context reference for consumer to modify
                compressed_summary=compressed_summary,
                original_messages_count=original_count,
                trigger_reason=trigger_reason,
                compression_duration_ms=duration_ms,
                original_approx_tokens=original_approx_tokens,
                compressed_approx_tokens=compressed_approx_tokens,
                timestamp=timestamp,
            )
            await self._produce(frame)

        finally:
            self._compression_in_progress = False
            self._pending_trigger_reason = None

    def _create_failure_block(self, error_message: str, timestamp: datetime) -> str:
        """Create a compression failure block."""
        ts = timestamp.isoformat()
        return f"<compression_failure timestamp={ts}>{error_message}</compression_failure>"

    def _estimate_tokens(self, messages: list) -> int:
        """Estimate token count from messages (rough: chars / 4)."""
        total_chars = 0
        for msg in messages:
            content = msg.get("content", "") if isinstance(msg, dict) else ""
            if isinstance(content, str):
                total_chars += len(content)
            elif isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and "text" in part:
                        total_chars += len(part["text"])
        return total_chars // 4

    def _estimate_tokens_from_text(self, text: str) -> int:
        """Estimate token count from text (rough: chars / 4)."""
        return len(text) // 4

    def _extract_recent_exchanges(self, messages: list, count: int = 3) -> list:
        """Extract the most recent user/assistant message exchanges as Gemini Content.

        Skips messages containing function/tool calls since they require paired
        function responses to satisfy Gemini's turn ordering constraints.
        """
        recent = []
        for msg in reversed(messages):
            if not isinstance(msg, dict):
                continue
            role = msg.get("role")
            if role not in ("user", "assistant"):
                continue
            # Skip assistant messages with function/tool calls
            if role == "assistant":
                content = msg.get("content")
                # Check for tool_calls field (OpenAI format)
                if msg.get("tool_calls"):
                    continue
                # Check for function_call in content (various formats)
                if isinstance(content, list):
                    has_function_call = any(
                        isinstance(part, dict)
                        and ("function_call" in part or "functionCall" in part)
                        for part in content
                    )
                    if has_function_call:
                        continue
            recent.insert(0, msg)
            if len(recent) >= count:
                break
        # Use Pipecat's adapter for conversion
        converted = self._adapter._from_universal_context_messages(recent)
        return converted.messages

    def _prepare_compression_messages(self, messages: list) -> list:
        """Prepare messages for compression as a single user message.

        The Gemini API requires conversations to end with a user message when
        using system_instruction. Instead of passing the conversation as multi-turn
        chat history, we format all messages into a single user message document.

        This approach treats compression as document analysis rather than
        conversation continuation.
        """
        # Build formatted conversation history
        lines = []
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            role = msg.get("role", "")
            if role == "system":
                continue  # Skip system messages
            content = msg.get("content", "")
            if isinstance(content, str):
                lines.append(f"[{role.upper()}]: {content}")
            elif isinstance(content, list):
                # Handle multi-part content
                text_parts = []
                for part in content:
                    if isinstance(part, dict) and "text" in part:
                        text_parts.append(part["text"])
                if text_parts:
                    lines.append(f"[{role.upper()}]: {' '.join(text_parts)}")

        conversation_text = "\n".join(lines)

        # Handle empty conversation (all messages filtered out)
        if not conversation_text.strip():
            logger.warning("No conversation content to compress after filtering")
            conversation_text = "[No conversation content available]"

        # Return as single user message
        formatted_message = (
            "CONVERSATION HISTORY TO COMPRESS\n"
            "----\n\n"
            f"{conversation_text}\n\n"
            "----\n"
            "END OF CONVERSATION HISTORY"
        )

        return [Content(role="user", parts=[Part(text=formatted_message)])]

    def _extract_text(self, response) -> str:
        """Extract text from Gemini response."""
        try:
            if not response.candidates:
                logger.debug(f"No candidates in response: {response}")
                return ""
            candidate = response.candidates[0]
            # Check for blocked responses
            if hasattr(candidate, "finish_reason") and candidate.finish_reason:
                logger.debug(f"Candidate finish_reason: {candidate.finish_reason}")
            if not candidate.content:
                logger.debug(f"No content in candidate: {candidate}")
                return ""
            parts = candidate.content.parts
            if not parts:
                logger.debug(f"No parts in content: {candidate.content}")
                return ""
            for part in parts:
                if hasattr(part, "text") and part.text:
                    return part.text
            logger.debug(f"No text in parts: {parts}")
        except (AttributeError, IndexError, TypeError) as e:
            logger.warning(f"Failed to extract text from response: {e}")
        return ""


class ContextCompressionConsumer(ConsumerProcessor):
    """Consumer that receives compression frames and applies them to context.

    This processor receives GradientBangContextCompressionFrame from the
    ContextCompressionProducer and modifies the LLMContext in-place.

    The LLMContext reference is passed via the frame itself (not cached from
    pipeline frames) because the LLM service consumes LLMContextFrame before
    it reaches this processor at the end of the pipeline.

    The compression frame flows through the pipeline normally after being
    processed - this allows future analytics processors to observe it.
    """

    def __init__(self, producer: ContextCompressionProducer):
        """Initialize the compression consumer.

        Args:
            producer: The ContextCompressionProducer to receive frames from
        """
        super().__init__(
            producer=producer,
            direction=FrameDirection.DOWNSTREAM,
        )

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        """Process frames, applying compression when received."""
        await super().process_frame(frame, direction)

        if isinstance(frame, GradientBangContextCompressionFrame):
            # Apply compression - frame continues downstream naturally
            await self._apply_compression(frame)

    async def _apply_compression(self, frame: GradientBangContextCompressionFrame):
        """Apply compression to the LLM context from the frame."""
        context = frame.context
        messages = context.messages
        original_count = frame.original_messages_count

        # Preserve messages added after compression started
        new_messages = messages[original_count:] if len(messages) > original_count else []

        # Preserve all system messages (role == "system")
        system_messages = [
            msg
            for msg in messages[:original_count]
            if isinstance(msg, dict) and msg.get("role") == "system"
        ]

        # Warn if multiple system messages found
        if len(system_messages) > 1:
            logger.warning(
                f"Found {len(system_messages)} system messages in context, expected 1. "
                "All will be preserved, but this may indicate a bug."
            )

        # Create new message list
        compressed_messages = []

        # Add system messages first
        compressed_messages.extend(system_messages)

        # Add summary as a user message
        compressed_messages.append(
            {
                "role": "user",
                "content": f"<session_history_summary>\n{frame.compressed_summary}\n</session_history_summary>",
            }
        )

        # Add messages that occurred during compression
        compressed_messages.extend(new_messages)

        # Update context in-place
        context.set_messages(compressed_messages)

        # Log compression metrics
        logger.info(
            f"Applied compression: {frame.original_messages_count} messages "
            f"({frame.original_approx_tokens} tokens) -> {len(compressed_messages)} messages "
            f"({frame.compressed_approx_tokens} tokens) in {frame.compression_duration_ms:.0f}ms "
            f"[trigger: {frame.trigger_reason}, preserved {len(new_messages)} new messages]"
        )
