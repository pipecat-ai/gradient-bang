#!/usr/bin/env python3
"""Strategy-driven combat CLI leveraging the TaskAgent."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.api_client import AsyncGameClient, RPCError
from utils.base_llm_agent import LLMConfig
from utils.task_agent import TaskAgent
from utils.combat_tools import (
    ChooseCombatActionTool,
    SetCombatCommitTool,
    ReviewCombatRoundTool,
)
from npc.combat_logging import configure_logger, format_participant_summary
from npc.combat_session import CombatSession, CombatState
from npc.combat_utils import ensure_position, compute_timeout


class CombatStrategyRuntime:
    """Tracks per-round state for the combat strategy agent."""

    def __init__(self) -> None:
        self.pending_action: Optional[Tuple[str, Optional[int], Optional[str], Optional[int]]] = None
        self.last_round: Optional[Dict[str, Any]] = None
        self.current_state: Optional[CombatState] = None
        self.current_payload: Optional[Dict[str, Any]] = None
        self.player_id: Optional[str] = None

    def reset_for_round(
        self, state: CombatState, payload: Dict[str, Any], *, player_id: str
    ) -> None:
        self.current_state = state
        self.current_payload = payload
        self.pending_action = None
        self.player_id = player_id

    def choose_action(
        self,
        action: str,
        commit: Optional[int],
        target: Optional[str],
        to_sector: Optional[int] = None,
    ) -> Dict[str, Any]:
        action = action.lower()
        if action not in {"attack", "brace", "flee"}:
            raise ValueError(f"Unsupported combat action: {action}")
        commit_value: Optional[int]
        destination_value: Optional[int]
        if action == "attack":
            commit_value = int(commit) if commit is not None else None
            target_value = str(target).strip() if target else None
            destination_value = None
        elif action == "flee":
            if to_sector is None:
                raise ValueError("Flee action requires to_sector")
            destination_value = int(to_sector)
            commit_value = 0
            target_value = None
        else:
            commit_value = 0
            target_value = None
            destination_value = None
        self.pending_action = (action, commit_value, target_value, destination_value)
        return {
            "acknowledged": True,
            "action": action,
            "commit": commit_value,
            "target": target_value,
            "to_sector": destination_value,
        }

    def set_commit(self, commit: int) -> Dict[str, Any]:
        if self.pending_action is None:
            raise ValueError("choose_combat_action must be called before set_commit")
        if commit < 0:
            raise ValueError("commit must be >= 0")
        action, _, target, destination = self.pending_action
        self.pending_action = (action, int(commit), target, destination)
        return {
            "acknowledged": True,
            "action": action,
            "commit": int(commit),
        }

    def review_last_round(self) -> Dict[str, Any]:
        return self.last_round or {"message": "no round resolved yet"}

    def record_round_result(self, payload: Dict[str, Any]) -> None:
        self.last_round = payload

    def consume_action(self) -> Tuple[str, int, Optional[str], Optional[int]]:
        if self.pending_action is None:
            return "brace", 0, None, None
        action, commit, target, destination = self.pending_action
        if action != "attack":
            commit_value = 0
        else:
            commit_value = int(commit if commit is not None else 0)
            target_value = target
            if not target_value and self.current_state:
                for pid, participant in self.current_state.participants.items():
                    candidate_id = participant.combatant_id
                    if candidate_id == self.player_id or pid == self.player_id:
                        continue
                    if participant.fighters <= 0:
                        continue
                    target_value = pid
                    break
            target = target_value
        self.pending_action = None
        return action, commit_value, target, destination


def load_combat_prompt() -> Dict[str, Any]:
    schema_path = Path(__file__).parent.parent / "utils" / "tool_schemas" / "combat.json"
    with schema_path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def build_system_prompt(strategy_text: str, mode: str) -> str:
    schema = load_combat_prompt()
    lines: List[str] = list(schema.get("system_message", []))
    lines.append(f"Engagement mode: {mode}.")
    lines.append(f"Strategy directive: {strategy_text}")
    note = schema.get("observation_note")
    if note:
        lines.append(note)
    return "\n".join(lines)


def compose_observation(
    state: CombatState,
    payload: Dict[str, Any],
    *,
    player_id: str,
    mode: str,
    strategy: str,
    runtime: CombatStrategyRuntime,
) -> str:
    opponents = []
    my_state: Dict[str, Any] = {}
    for pid, participant in state.participants.items():
        entry = participant.__dict__.copy()
        if pid == player_id or entry.get("combatant_id") == player_id:
            my_state = entry
        else:
            opponents.append(entry)

    observation = {
        "combat_id": state.combat_id,
        "round": state.round,
        "deadline": payload.get("deadline"),
        "mode": mode,
        "strategy": strategy,
        "my_state": my_state,
        "opponents": opponents,
        "last_round": runtime.review_last_round(),
        "salvage": state.salvage,
    }
    return json.dumps({"round_state": observation})


async def request_agent_action(
    agent: TaskAgent,
    runtime: CombatStrategyRuntime,
    observation: str,
    *,
    logger,
    deadline_seconds: Optional[float],
) -> Tuple[str, int, Optional[str], Optional[int]]:
    # Default quickly if we are out of time
    if deadline_seconds is not None and deadline_seconds < 2.0:
        logger.warning("Insufficient time for LLM response (%.2fs); defaulting to brace.", deadline_seconds)
        return "brace", 0, None, None

    runtime.pending_action = None
    agent.add_message({"role": "user", "content": observation})

    max_attempts = 3
    for attempt in range(max_attempts):
        try:
            response = await agent.get_assistant_response()
        except Exception as exc:  # noqa: BLE001
            logger.error("LLM request failed: %s", exc)
            break

        agent.add_message(response)

        tool_calls = response.get("tool_calls") or []
        if not tool_calls:
            agent.add_message(
                {
                    "role": "user",
                    "content": "Reminder: select the next action using choose_combat_action.",
                }
            )
            continue

        for tool_call in tool_calls:
            tool_message, _, _ = await agent.process_tool_call(tool_call)
            if tool_message:
                agent.add_message(tool_message)

        if runtime.pending_action is not None:
            break

    action, commit, target, destination = runtime.consume_action()
    if action == "attack" and commit <= 0:
        # Ensure a legal commit
        commit = max(commit, 1)
    return action, commit, target, destination


async def handle_combat(
    session: CombatSession,
    agent: TaskAgent,
    runtime: CombatStrategyRuntime,
    client: AsyncGameClient,
    *,
    character_id: str,
    logger,
    mode: str,
    strategy: str,
    action_timeout: Optional[float],
) -> None:
    player_id = session.player_combatant_id() or character_id

    announced_start = False
    active = True
    while active:
        event_name, state, payload = await session.next_combat_event()
        if event_name == "combat.round_waiting":
            if not announced_start:
                summary = format_participant_summary(
                    participant.__dict__
                    for pid, participant in state.participants.items()
                    if pid != player_id
                )
                agent.add_message(
                    {
                        "role": "user",
                        "content": json.dumps(
                            {
                                "event": "combat_started",
                                "combat_id": state.combat_id,
                                "opponents": summary,
                            }
                        ),
                    }
                )
                logger.info(
                    "Combat %s engaged. Opponents: %s", state.combat_id, summary or "(none)"
                )
                announced_start = True

            runtime.reset_for_round(state, payload, player_id=player_id)
            deadline_seconds = compute_timeout(payload.get("deadline"), action_timeout)
            observation = compose_observation(
                state,
                payload,
                player_id=player_id,
                mode=mode,
                strategy=strategy,
                runtime=runtime,
            )
            action, commit, target_id, to_sector = await request_agent_action(
                agent,
                runtime,
                observation,
                logger=logger,
                deadline_seconds=deadline_seconds,
            )
            try:
                await client.combat_action(
                    combat_id=state.combat_id,
                    action=action,
                    commit=commit,
                    round_number=state.round,
                    target_id=target_id,
                    to_sector=to_sector,
                )
                if action == "attack" and target_id:
                    logger.info("Submitted attack on %s (commit=%s)", target_id, commit)
                elif action == "flee" and to_sector is not None:
                    logger.info("Submitted flee to sector %s", to_sector)
                else:
                    logger.info("Submitted %s (commit=%s)", action, commit)
            except RPCError as exc:
                logger.error("Failed to submit combat action: %s", exc)
            continue

        if event_name == "combat.round_resolved":
            runtime.record_round_result(payload)
            agent.add_message(
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "event": "round_resolved",
                            "round": state.round,
                            "ship": payload.get("ship"),
                            "result": payload.get("result") or payload.get("end"),
                        }
                    ),
                }
            )
            logger.info(
                "Round %s resolved. Fighters remaining: %s",
                state.round,
                payload.get("ship"),
            )
            continue

        if event_name == "combat.ended":
            runtime.record_round_result(payload)
            result = state.result or payload.get("result") or payload.get("end")
            agent.add_message(
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "event": "combat_ended",
                            "result": result,
                            "salvage": payload.get("salvage"),
                        }
                    ),
                }
            )
            logger.info("Combat complete (%s)", result or "no result")
            salvage = payload.get("salvage") or []
            if salvage:
                logger.info("Salvage available: %s", salvage)
            active = False


async def strategy_main() -> int:
    parser = argparse.ArgumentParser(description="Autonomous combat strategy CLI")
    parser.add_argument("sector", type=int, help="Sector to patrol")
    parser.add_argument("mode", choices=["fight", "wait"], help="Engagement mode")
    parser.add_argument("strategy", help="Natural language strategy directive for the agent")
    parser.add_argument("--character", default=os.getenv("NPC_CHARACTER_ID"))
    parser.add_argument(
        "--server",
        default=os.getenv("GAME_SERVER_URL", "http://localhost:8000"),
        help="Game server URL",
    )
    parser.add_argument(
        "--model",
        default=os.getenv("NPC_MODEL", "gpt-5"),
        help="OpenAI model to use",
    )
    parser.add_argument("--verbose", action="store_true", help="Verbose logging")
    parser.add_argument(
        "--verbose-prompts",
        action="store_true",
        help="Log full prompt/response traffic",
    )
    parser.add_argument(
        "--action-timeout",
        type=float,
        default=None,
        help="Override round decision timeout in seconds",
    )
    args = parser.parse_args()

    if not args.character:
        raise SystemExit("Character ID required via --character or NPC_CHARACTER_ID")
    if not os.getenv("OPENAI_API_KEY"):
        raise SystemExit("OPENAI_API_KEY environment variable is required")

    logger = configure_logger("npc.combat.strategy", verbose=args.verbose)

    runtime = CombatStrategyRuntime()
    system_prompt = build_system_prompt(args.strategy, args.mode)

    try:
        async with AsyncGameClient(
            base_url=args.server,
            character_id=args.character,
        ) as client:
            logger.info(
                "Connecting to %s as %s", args.server, args.character
            )
            status = await client.join(args.character)
            logger.info("Joined; current sector %s", status.get("sector"))
            status = await ensure_position(
                client,
                status,
                target_sector=args.sector,
                logger=logger,
            )
            logger.info("Standing by in sector %s", status.get("sector"))

            agent = TaskAgent(
                config=LLMConfig(api_key=os.getenv("OPENAI_API_KEY"), model=args.model),
                verbose_prompts=args.verbose_prompts,
                game_client=client,
                character_id=args.character,
            )
            agent.set_tools(
                [
                    (ChooseCombatActionTool, {"runtime": runtime}),
                    (SetCombatCommitTool, {"runtime": runtime}),
                    (ReviewCombatRoundTool, {"runtime": runtime}),
                ]
            )
            agent.messages = []
            agent.add_message({"role": "system", "content": system_prompt})

            async with CombatSession(
                client,
                character_id=args.character,
                logger=logger,
                initial_status=status,
            ) as session:
                logger.info("Monitoring for opponents...")
                while True:
                    opponents = await session.wait_for_other_player()
                    opponent_names = sorted(opponents.keys())
                    logger.info("Detected opponents: %s", ", ".join(opponent_names))

                    if args.mode == "fight":
                        target = next((name for name in opponent_names if name != args.character), None)
                        if target:
                            try:
                                await client.combat_initiate(
                                    character_id=args.character,
                                    target_id=target,
                                    target_type="character",
                                )
                                logger.info("Initiated combat against %s", target)
                            except RPCError as exc:
                                logger.error("Failed to initiate combat: %s", exc)
                                continue
                        else:
                            logger.info("No player target available; waiting for engagement.")
                    else:
                        logger.info("Wait mode active; holding position until attacked.")

                    state = await session.wait_for_combat_start()
                    logger.info(
                        "Combat %s starting in round %s",
                        state.combat_id,
                        state.round,
                    )
                    runtime.last_round = None
                    await handle_combat(
                        session,
                        agent,
                        runtime,
                        client,
                        character_id=args.character,
                        logger=logger,
                        mode=args.mode,
                        strategy=args.strategy,
                        action_timeout=args.action_timeout,
                    )
                    logger.info("Engagement ended; resuming patrol")
    except KeyboardInterrupt:
        logger.info("Interrupted by user; exiting")
        return 130

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(strategy_main()))
