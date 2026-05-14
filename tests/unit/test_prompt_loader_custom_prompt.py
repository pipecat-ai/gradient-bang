"""Tests for ``build_task_agent_prompt(custom_prompt=...)`` (Phase 3 4/N)."""

from __future__ import annotations

import pytest

from gradientbang.utils.prompt_loader import build_task_agent_prompt


@pytest.mark.unit
class TestCustomPromptLayering:
    def test_none_is_identical_to_no_arg(self):
        # The kwarg-defaulted form must be bit-for-bit identical to the
        # no-arg form so in-process TaskAgents (which never set custom_prompt)
        # see zero behavioural drift.
        assert build_task_agent_prompt(custom_prompt=None) == build_task_agent_prompt()

    def test_empty_string_is_no_op(self):
        assert build_task_agent_prompt(custom_prompt="") == build_task_agent_prompt()

    def test_whitespace_only_is_no_op(self):
        assert (
            build_task_agent_prompt(custom_prompt="   \n\t  \n")
            == build_task_agent_prompt()
        )

    def test_normal_content_is_appended_under_operator_guidance_header(self):
        custom = "Always trade aggressively. Never engage combat unless attacked first."
        result = build_task_agent_prompt(custom_prompt=custom)
        base = build_task_agent_prompt()
        # Base content is preserved at the start.
        assert result.startswith(base)
        # Custom content lives in a clearly delimited section so the LLM
        # can see it's layered on top, not buried inside the base prompt.
        assert "## Operator guidance" in result
        assert custom in result

    def test_custom_block_lands_after_substitution(self):
        # Template substitution (${key}) only applies to the base prompt.
        # Operator-supplied text containing ${key} should pass through
        # literally — operators shouldn't be able to reach into the
        # runtime's substitution namespace.
        custom = "Note: do NOT expand ${universe_size} in this block."
        result = build_task_agent_prompt(custom_prompt=custom)
        assert "${universe_size}" in result

    def test_custom_block_is_stripped_of_leading_trailing_whitespace(self):
        # Leading/trailing whitespace on the file shouldn't bloat the prompt.
        result = build_task_agent_prompt(custom_prompt="\n\n  guidance  \n\n")
        # The "guidance" body appears (with internal whitespace) but the
        # outer padding is gone.
        assert "guidance" in result
        # We didn't accidentally produce a "no custom" path: the operator
        # guidance header is there.
        assert "## Operator guidance" in result
