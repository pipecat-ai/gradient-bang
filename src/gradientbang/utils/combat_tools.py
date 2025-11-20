"""Combat-specific tool implementations for strategy agent."""

from __future__ import annotations

from typing import Any, Optional

from gradientbang.utils.tools_schema import FunctionSchema, Tool


class ChooseCombatActionTool(Tool):
    """Tool allowing the agent to select the next combat action."""

    def __init__(self, *, runtime, game_client=None, **kwargs):  # noqa: D401
        super().__init__(**kwargs)
        self.runtime = runtime

    def __call__(self, **args) -> Any:
        action = str(args.get("action", "")).lower().strip()
        commit = args.get("commit")
        target = args.get("target")
        to_sector = args.get("to_sector")
        return self.runtime.choose_action(action, commit, target, to_sector)

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="choose_combat_action",
            description=(
                "Select the action to perform this combat round. Call once per round. "
                "Valid actions: attack, brace, flee. Include commit when attacking."
            ),
            properties={
                "action": {
                    "type": "string",
                    "enum": ["attack", "brace", "flee"],
                    "description": "Action to perform this round.",
                },
                "commit": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Number of fighters to commit when attacking (optional).",
                },
                "target": {
                    "type": ["string", "null"],
                    "description": "Target combatant identifier when performing an attack.",
                },
                "to_sector": {
                    "type": ["integer", "null"],
                    "description": "Destination sector when fleeing.",
                },
            },
            required=["action"],
        )


class SetCombatCommitTool(Tool):
    """Tool allowing the agent to adjust fighter commitment after choosing an action."""

    def __init__(self, *, runtime, game_client=None, **kwargs):
        super().__init__(**kwargs)
        self.runtime = runtime

    def __call__(self, **args) -> Any:
        commit_value = int(args.get("commit", 0))
        return self.runtime.set_commit(commit_value)

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="set_commit",
            description=(
                "Update the fighter commitment for the previously selected action. "
                "Must follow a choose_combat_action call if used."
            ),
            properties={
                "commit": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Number of fighters to commit for this round.",
                }
            },
            required=["commit"],
        )


class ReviewCombatRoundTool(Tool):
    """Return the structured log for the most recent combat round."""

    def __init__(self, *, runtime, game_client=None, **kwargs):
        super().__init__(**kwargs)
        self.runtime = runtime

    def __call__(self, **args) -> Any:  # noqa: D401
        return self.runtime.review_last_round()

    @classmethod
    def schema(cls):
        return FunctionSchema(
            name="review_round_log",
            description="Fetch the structured payload for the last resolved combat round.",
            properties={},
            required=[],
        )


__all__ = [
    "ChooseCombatActionTool",
    "SetCombatCommitTool",
    "ReviewCombatRoundTool",
]
