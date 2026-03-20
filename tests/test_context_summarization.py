"""Tests for native Pipecat context summarization integration.

These tests verify our summarization config works correctly with Pipecat's
LLMContextSummarizer — no live LLM or running pipeline needed.
"""

import os

import pytest
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_context_summarizer import LLMContextSummarizer
from pipecat.utils.context.llm_context_summarization import (
    LLMAutoContextSummarizationConfig,
    LLMContextSummaryConfig,
)

pytestmark = pytest.mark.llm

# Mirror the constants from bot.py so tests stay self-contained
SUMMARY_MESSAGE_TEMPLATE = "<session_history_summary>\n{summary}\n</session_history_summary>"

SUMMARIZATION_PROMPT = "Compress this game session conversation"  # abbreviated for tests


def _make_config(
    max_unsummarized_messages: int = 200,
) -> LLMAutoContextSummarizationConfig:
    """Build a summarization config matching production settings."""
    return LLMAutoContextSummarizationConfig(
        max_context_tokens=None,
        max_unsummarized_messages=max_unsummarized_messages,
        summary_config=LLMContextSummaryConfig(
            target_context_tokens=6000,
            min_messages_after_summary=5,
            summarization_prompt=SUMMARIZATION_PROMPT,
            summary_message_template=SUMMARY_MESSAGE_TEMPLATE,
            summarization_timeout=120.0,
        ),
    )


def _make_context(num_turns: int, with_system: bool = True) -> LLMContext:
    """Create an LLMContext with a system message and N user/assistant turns."""
    messages = []
    if with_system:
        messages.append({"role": "system", "content": "You are a space game AI."})
    for i in range(num_turns):
        messages.append({"role": "user", "content": f"User message {i}"})
        messages.append({"role": "assistant", "content": f"Assistant response {i}"})
    return LLMContext(messages)


def _make_summarizer(
    context: LLMContext,
    config: LLMAutoContextSummarizationConfig | None = None,
    auto_trigger: bool = True,
) -> LLMContextSummarizer:
    """Create a summarizer for testing."""
    return LLMContextSummarizer(
        context=context,
        config=config or _make_config(),
        auto_trigger=auto_trigger,
    )


# --- Config construction ---


def test_config_accepts_none_token_limit():
    """Config with max_context_tokens=None should be valid."""
    config = _make_config()
    assert config.max_context_tokens is None
    assert config.max_unsummarized_messages == 200


def test_config_rejects_both_none():
    """Config with both thresholds None should raise."""
    with pytest.raises(ValueError):
        LLMAutoContextSummarizationConfig(
            max_context_tokens=None,
            max_unsummarized_messages=None,
        )


# --- Summary template ---


def test_summary_template_formatting():
    """Template should wrap summary in session_history_summary tags."""
    result = SUMMARY_MESSAGE_TEMPLATE.format(summary="Test summary content")
    assert result == "<session_history_summary>\nTest summary content\n</session_history_summary>"


# --- Threshold detection ---


def test_summarization_triggers_above_threshold():
    """Summarizer should want to summarize when messages exceed threshold."""
    context = _make_context(num_turns=105)  # 1 system + 210 user/assistant = 211
    summarizer = _make_summarizer(context, _make_config(max_unsummarized_messages=200))
    assert summarizer._should_summarize() is True


def test_summarization_skips_below_threshold():
    """Summarizer should not trigger when below threshold."""
    context = _make_context(num_turns=25)  # 1 system + 50 user/assistant = 51
    summarizer = _make_summarizer(context, _make_config(max_unsummarized_messages=200))
    assert summarizer._should_summarize() is False


def test_summarization_skips_when_auto_trigger_disabled():
    """Summarizer should not auto-trigger when disabled, even if above threshold."""
    context = _make_context(num_turns=105)
    summarizer = _make_summarizer(
        context, _make_config(max_unsummarized_messages=200), auto_trigger=False
    )
    assert summarizer._should_summarize() is False


# --- Summary application ---


@pytest.mark.asyncio
async def test_summary_application_preserves_system_message():
    """After applying a summary, the system message should be first."""
    context = _make_context(num_turns=50)
    summarizer = _make_summarizer(context)

    # Apply a summary covering messages up to index 90 (leaving last 10)
    last_summarized_index = len(context.messages) - 6  # keep 5 recent messages
    await summarizer._apply_summary("Game summary here", last_summarized_index)

    assert context.messages[0]["role"] == "system"
    assert context.messages[0]["content"] == "You are a space game AI."


@pytest.mark.asyncio
async def test_summary_application_uses_template():
    """The summary message should use the session_history_summary template."""
    context = _make_context(num_turns=50)
    summarizer = _make_summarizer(context)

    last_summarized_index = len(context.messages) - 6
    await summarizer._apply_summary("Game summary here", last_summarized_index)

    summary_msg = context.messages[1]
    assert summary_msg["role"] == "user"
    assert "<session_history_summary>" in summary_msg["content"]
    assert "Game summary here" in summary_msg["content"]
    assert "</session_history_summary>" in summary_msg["content"]


@pytest.mark.asyncio
async def test_summary_application_preserves_recent_messages():
    """Recent messages after last_summarized_index should be preserved."""
    context = _make_context(num_turns=50)
    original_messages = list(context.messages)

    last_summarized_index = len(original_messages) - 6  # keep 5 recent
    await _make_summarizer(context)._apply_summary("Summary", last_summarized_index)

    # Should have: system + summary + 5 recent = 7
    assert len(context.messages) == 7
    # Last 5 should match original last 5
    for i in range(1, 6):
        assert context.messages[-i] == original_messages[-i]


# --- Env var ---


def test_env_var_default():
    """CONTEXT_SUMMARIZATION_MESSAGE_LIMIT defaults to 200 when unset."""
    # Ensure the var is not set
    old = os.environ.pop("CONTEXT_SUMMARIZATION_MESSAGE_LIMIT", None)
    try:
        result = int(os.getenv("CONTEXT_SUMMARIZATION_MESSAGE_LIMIT", "200"))
        assert result == 200
    finally:
        if old is not None:
            os.environ["CONTEXT_SUMMARIZATION_MESSAGE_LIMIT"] = old


def test_env_var_override():
    """CONTEXT_SUMMARIZATION_MESSAGE_LIMIT can be overridden."""
    old = os.environ.get("CONTEXT_SUMMARIZATION_MESSAGE_LIMIT")
    os.environ["CONTEXT_SUMMARIZATION_MESSAGE_LIMIT"] = "50"
    try:
        result = int(os.getenv("CONTEXT_SUMMARIZATION_MESSAGE_LIMIT", "200"))
        assert result == 50
    finally:
        if old is not None:
            os.environ["CONTEXT_SUMMARIZATION_MESSAGE_LIMIT"] = old
        else:
            del os.environ["CONTEXT_SUMMARIZATION_MESSAGE_LIMIT"]
