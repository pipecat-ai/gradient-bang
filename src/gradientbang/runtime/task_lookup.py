"""Pure helpers for resolving active TaskAgent workers."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from gradientbang.runtime.subagents.task_agent import TaskAgent


def find_task_agent_in_groups(
    job_groups: Mapping[str, Any],
    children: Sequence[Any],
    task_id: str,
) -> tuple[str, TaskAgent] | None:
    """Resolve a framework task id or prefix to its active TaskAgent.

    ``job_groups`` is keyed by the framework task id and each group records
    the worker names handling that job. ``children`` is the current worker
    list on the player host. The lookup accepts either the full id or a
    prefix, preferring an exact id match when multiple jobs share a prefix.
    """
    cleaned = task_id.strip()
    if not cleaned:
        return None

    matches = [
        (tid, group)
        for tid, group in job_groups.items()
        if tid == cleaned or tid.startswith(cleaned)
    ]
    if not matches:
        return None

    matches.sort(key=lambda kv: 0 if kv[0] == cleaned else 1)
    framework_task_id, group = matches[0]
    for name in group.worker_names:
        child = next(
            (c for c in children if isinstance(c, TaskAgent) and c.name == name),
            None,
        )
        if child:
            return framework_task_id, child
    return None


def find_player_task(
    job_groups: Mapping[str, Any],
    children: Sequence[Any],
) -> tuple[str, TaskAgent] | None:
    """Return the active player-ship task and child worker, if one exists.

    Player tasks are represented by ``TaskAgent`` children where
    ``_is_corp_ship`` is false. The returned task id is the framework job id
    associated with that child, so callers can cancel or query the Pipecat job
    rather than the internal worker name.
    """
    player_child = next(
        (c for c in children if isinstance(c, TaskAgent) and not c._is_corp_ship),
        None,
    )
    if not player_child:
        return None

    framework_task_id = next(
        (tid for tid, group in job_groups.items() if player_child.name in group.worker_names),
        None,
    )
    if framework_task_id is None:
        return None
    return framework_task_id, player_child


def job_ids_to_cancel_for_player_combat(
    job_groups: Mapping[str, Any],
    player_worker_names: set[str],
) -> list[str]:
    """List active job ids owned by player TaskAgents that combat should cancel.

    Combat interrupts only player-ship automation; corporation ship tasks keep
    running. Callers pass the worker names already identified as player tasks,
    and this helper maps those names back to framework job ids.
    """
    return [tid for tid, group in job_groups.items() if group.worker_names & player_worker_names]
