from unittest.mock import MagicMock

import pytest
from pipecat.pipeline.job_context import JobGroup

from gradientbang.runtime.subagents.task_agent import TaskAgent
from gradientbang.runtime.task_lookup import (
    find_player_task,
    find_task_agent_in_groups,
    job_ids_to_cancel_for_player_combat,
)

pytestmark = pytest.mark.unit


def _task_agent(name: str, *, is_corp_ship: bool = False):
    child = MagicMock(spec=TaskAgent)
    child.name = name
    child._is_corp_ship = is_corp_ship
    return child


def test_find_task_agent_in_groups_accepts_full_id_and_prefix() -> None:
    child = _task_agent("task_abc123")
    full_id = "ff3fa419-1234-5678-9abc-def012345678"
    groups = {full_id: JobGroup(job_id=full_id, worker_names={"task_abc123"})}

    assert find_task_agent_in_groups(groups, [child], full_id) == (full_id, child)
    assert find_task_agent_in_groups(groups, [child], "ff3fa419") == (full_id, child)
    assert find_task_agent_in_groups(groups, [child], "ff") == (full_id, child)
    assert find_task_agent_in_groups(groups, [child], "deadbeef") is None
    assert find_task_agent_in_groups(groups, [child], "") is None
    assert find_task_agent_in_groups(groups, [child], "   ") is None


def test_find_task_agent_in_groups_prefers_exact_match() -> None:
    first = _task_agent("task_aaa")
    second = _task_agent("task_bbb")
    groups = {
        "ff": JobGroup(job_id="ff", worker_names={"task_aaa"}),
        "ff3fa419": JobGroup(job_id="ff3fa419", worker_names={"task_bbb"}),
    }

    assert find_task_agent_in_groups(groups, [first, second], "ff") == ("ff", first)
    assert find_task_agent_in_groups(groups, [first, second], "ff3fa") == (
        "ff3fa419",
        second,
    )


def test_find_player_task_returns_non_corp_task_job_id() -> None:
    corp = _task_agent("task_corp", is_corp_ship=True)
    player = _task_agent("task_player")
    groups = {
        "corp-job": JobGroup(job_id="corp-job", worker_names={"task_corp"}),
        "player-job": JobGroup(job_id="player-job", worker_names={"task_player"}),
    }

    assert find_player_task(groups, [corp, player]) == ("player-job", player)


def test_job_ids_to_cancel_for_player_combat_filters_to_player_worker_names() -> None:
    groups = {
        "corp-job": JobGroup(job_id="corp-job", worker_names={"task_corp"}),
        "player-job": JobGroup(job_id="player-job", worker_names={"task_player"}),
    }

    assert job_ids_to_cancel_for_player_combat(groups, {"task_player"}) == ["player-job"]
