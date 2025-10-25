import asyncio
from typing import Any, Dict, List, Mapping, Optional

import pytest

from npc import simple_tui
from utils.task_agent import TaskOutputType


class FakeAsyncGameClient:
    def __init__(self, base_url: str, character_id: str, websocket_frame_callback=None):
        self.base_url = base_url
        self.character_id = character_id
        self.websocket_frame_callback = websocket_frame_callback
        self._handlers: Dict[str, List[Any]] = {}
        self.paused = False
        self.closed = False

    def on(self, event_name: str):
        def decorator(handler):
            self._handlers.setdefault(event_name, []).append(handler)
            return handler

        return decorator

    async def join(self, character_id: str) -> Dict[str, Any]:
        assert character_id == self.character_id
        return {"sector": {"id": 7}}

    async def subscribe_my_messages(self) -> None:
        return None

    async def pause_event_delivery(self) -> None:
        self.paused = True

    async def resume_event_delivery(self) -> None:
        self.paused = False

    async def my_status(self, character_id: str) -> Mapping[str, Any]:
        assert character_id == self.character_id
        return {"status": "ok"}

    async def close(self) -> None:
        self.closed = True

    async def emit_event(
        self,
        event_name: str,
        payload: Optional[Dict[str, Any]] = None,
        summary: Optional[str] = None,
    ) -> None:
        event = {
            "event_name": event_name,
            "payload": payload or {},
            "summary": summary,
        }
        handlers = list(self._handlers.get(event_name, []))
        for handler in handlers:
            await handler(event)


class FakeTaskAgent:
    def __init__(
        self,
        *,
        game_client: FakeAsyncGameClient,
        character_id: str,
        output_callback=None,
        **_: Any,
    ) -> None:
        self._client = game_client
        self.character_id = character_id
        self.output_callback = output_callback
        self.finished_message: Optional[str] = None

    async def run_task(
        self,
        *,
        task: str,
        initial_state: Optional[Dict[str, Any]] = None,
        max_iterations: int,
    ) -> bool:
        assert initial_state is not None
        if self.output_callback:
            self.output_callback("step", "STEP")
            self.output_callback("ignore", TaskOutputType.EVENT.value)
            self.output_callback("complete", TaskOutputType.FINISHED.value)
        await self._client.emit_event(
            "status.update",
            payload={"credits": 100},
            summary="Status stable",
        )
        self.finished_message = f"Finished {task}"
        return True


@pytest.mark.asyncio
async def test_programmatic_runner_executes_tasks(monkeypatch):
    logs: List[str] = []

    def capture_log(self, message: str, *, level: str = "INFO") -> None:  # type: ignore[override]
        logs.append(f"{level}:{message}")

    monkeypatch.setattr(simple_tui, "AsyncGameClient", FakeAsyncGameClient)
    monkeypatch.setattr(simple_tui, "TaskAgent", FakeTaskAgent)
    monkeypatch.setattr(
        simple_tui.ProgrammaticSimpleRunner,
        "_log_line",
        capture_log,
        raising=False,
    )

    runner = simple_tui.ProgrammaticSimpleRunner(
        server="http://localhost:8000",
        character_id="codex-1",
        tasks=["map the sector"],
        max_iterations=5,
        log_level="INFO",
        log_path=None,
        thinking_budget=None,
        idle_timeout=None,
    )

    exit_code = await runner.run()

    assert exit_code == 0
    assert any("Starting scripted task" in entry for entry in logs)
    assert any("Task 'map the sector' completed with success" in entry for entry in logs)
    assert any("status.update" in entry for entry in logs)
    assert any("Task finished message" in entry for entry in logs)
