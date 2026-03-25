"""End-to-end test harness: real agents, real bus, real game server, scripted LLM.

Wires VoiceAgent + EventRelay + TaskAgent with a real AsyncQueueBus and real
AsyncGameClient pointing at the test Supabase instance. The only mock is the
LLM service, which emits scripted tool call sequences.

Usage:
    harness = E2EHarness(character_id, edge_api, make_game_client)
    await harness.start()
    await harness.join_game()
    # ... drive scenarios ...
    await harness.stop()
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any, Mapping, Optional, Sequence
from unittest.mock import AsyncMock, MagicMock

from loguru import logger
from pipecat.frames.frames import (
    FunctionCallFromLLM,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMMessagesAppendFrame,
    LLMThoughtTextFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.llm_service import LLMService

from gradientbang.subagents.bus import AsyncQueueBus
import httpx
from gradientbang.pipecat_server.subagents.event_relay import EventRelay
from gradientbang.pipecat_server.subagents.task_agent import TaskAgent
from gradientbang.pipecat_server.subagents.voice_agent import VoiceAgent


# ── EdgeAPI ───────────────────────────────────────────────────────────────


class EdgeAPI:
    """Direct edge function caller, like the Deno test helpers."""

    def __init__(self, base_url: str, service_key: str):
        import os

        self.base_url = os.environ.get("EDGE_FUNCTIONS_URL", f"{base_url}/functions/v1")
        self.service_key = service_key
        self._http = httpx.AsyncClient(timeout=30.0)

    async def call(self, endpoint: str, payload: dict = None) -> dict:
        resp = await self._http.post(
            f"{self.base_url}/{endpoint}",
            json=payload or {},
            headers={"Content-Type": "application/json"},
        )
        return resp.json()

    async def call_ok(self, endpoint: str, payload: dict = None) -> dict:
        result = await self.call(endpoint, payload)
        assert result.get("success"), f"{endpoint} failed: {result}"
        return result

    async def events_since(
        self, character_id: str, since_event_id: int = 0, limit: int = 100
    ) -> list[dict]:
        result = await self.call_ok(
            "events_since",
            {"character_ids": [character_id], "since_event_id": since_event_id, "limit": limit},
        )
        return result.get("events", [])

    async def close(self):
        await self._http.aclose()


# ── DB helpers ────────────────────────────────────────────────────────────


async def db_request(supabase_url: str, service_key: str, method: str, path: str, json=None):
    """Make a PostgREST request to the test DB."""
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        fn = getattr(client, method)
        kwargs = {"headers": headers}
        if json is not None:
            kwargs["json"] = json
        return await fn(f"{supabase_url}/rest/v1/{path}", **kwargs)


async def seed_mega_port_at_sector_0(supabase_url: str, service_key: str):
    """Insert a port at sector 0 (the mega-port sector in the test universe)."""
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"{supabase_url}/rest/v1/ports",
            json={
                "sector_id": 0, "port_code": "SSS", "port_class": 9,
                "max_qf": 5000, "max_ro": 5000, "max_ns": 5000,
                "stock_qf": 5000, "stock_ro": 5000, "stock_ns": 5000,
            },
            headers=headers,
        )
        port = resp.json()
        port_id = port[0]["port_id"] if isinstance(port, list) else port.get("port_id")
        await client.patch(
            f"{supabase_url}/rest/v1/sector_contents?sector_id=eq.0",
            json={"port_id": port_id},
            headers={**headers, "Prefer": "return=minimal"},
        )


async def get_ship_id(supabase_url: str, service_key: str, character_id: str) -> str:
    resp = await db_request(supabase_url, service_key, "get",
        f"characters?character_id=eq.{character_id}&select=current_ship_id")
    return resp.json()[0]["current_ship_id"]


async def set_ship_sector(supabase_url: str, service_key: str, ship_id: str, sector: int):
    await db_request(supabase_url, service_key, "patch",
        f"ship_instances?ship_id=eq.{ship_id}", json={"current_sector": sector})


async def set_ship_credits(supabase_url: str, service_key: str, ship_id: str, credits: int):
    await db_request(supabase_url, service_key, "patch",
        f"ship_instances?ship_id=eq.{ship_id}", json={"credits": credits})


async def create_corporation_direct(
    supabase_url: str, service_key: str, founder_id: str, name: str = "Test Corp"
) -> str:
    """Insert a corporation directly into the DB, returning the corp_id."""
    import uuid as _uuid
    corp_id = str(_uuid.uuid4())
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"{supabase_url}/rest/v1/corporations",
            json={
                "corp_id": corp_id,
                "name": name,
                "founder_id": founder_id,
                "invite_code": f"TEST-{_uuid.uuid4().hex[:6].upper()}",
            },
            headers=headers,
        )
        assert resp.status_code in (200, 201), f"create_corporation failed: {resp.text}"
    # Update the founder's corporation_id
    await db_request(supabase_url, service_key, "patch",
        f"characters?character_id=eq.{founder_id}", json={"corporation_id": corp_id})
    return corp_id


async def create_corp_ship_direct(
    supabase_url: str, service_key: str, corp_id: str, sector: int = 0,
    ship_name: str = "Corp Scout",
) -> str:
    """Insert a corporation ship with pseudo-character, returning the ship_id."""
    import uuid as _uuid
    ship_id = str(_uuid.uuid4())
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        # 1. Ship instance
        resp = await client.post(
            f"{supabase_url}/rest/v1/ship_instances",
            json={
                "ship_id": ship_id,
                "owner_id": corp_id,
                "owner_type": "corporation",
                "owner_corporation_id": corp_id,
                "ship_type": "kestrel_courier",
                "ship_name": ship_name,
                "current_sector": sector,
                "in_hyperspace": False,
                "credits": 1000,
                "cargo_qf": 0, "cargo_ro": 0, "cargo_ns": 0,
                "current_warp_power": 500,
                "current_shields": 150,
                "current_fighters": 300,
                "metadata": {},
            },
            headers=headers,
        )
        assert resp.status_code in (200, 201), f"create ship_instances failed: {resp.text}"

        # 2. Pseudo-character (character_id = ship_id)
        resp = await client.post(
            f"{supabase_url}/rest/v1/characters",
            json={
                "character_id": ship_id,
                "name": f"corp-ship-{ship_name}",
                "current_ship_id": ship_id,
                "credits_in_megabank": 0,
                "map_knowledge": {"sectors_visited": {}, "total_sectors_visited": 0},
                "player_metadata": {"player_type": "corporation_ship"},
                "is_npc": True,
                "corporation_id": corp_id,
            },
            headers=headers,
        )
        assert resp.status_code in (200, 201), f"create pseudo-character failed: {resp.text}"

        # 3. Corporation ships linkage
        resp = await client.post(
            f"{supabase_url}/rest/v1/corporation_ships",
            json={"corp_id": corp_id, "ship_id": ship_id},
            headers=headers,
        )
        assert resp.status_code in (200, 201), f"create corporation_ships failed: {resp.text}"

    return ship_id


# ── ScriptedLLMService ────────────────────────────────────────────────────


class ScriptedLLMService(LLMService):
    """LLM service that emits a scripted sequence of tool calls.

    Each time inference is triggered (LLMContextFrame received), it pops
    the next tool call from the script and emits the appropriate frames.
    When the script is exhausted, it calls the `finished` tool.

    Args:
        script: List of (tool_name, arguments_dict) tuples to execute in order.
        thinking_text: Optional text to emit as LLMThoughtTextFrame before each tool call.
    """

    def __init__(
        self,
        script: list[tuple[str, dict]],
        *,
        thinking_text: Optional[str] = None,
        gate: Optional[asyncio.Event] = None,
    ):
        super().__init__(run_in_parallel=False, function_call_timeout_secs=30.0)
        self._script = list(script)
        self._thinking_text = thinking_text
        self._call_index = 0
        self._gate = gate  # If set, wait for this event before each tool call

    async def process_frame(self, frame: Any, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMContextFrame):
            await self._process_context(frame.context)
        else:
            await self.push_frame(frame, direction)

    async def _process_context(self, context: Any):
        if self._gate is not None:
            await self._gate.wait()

        await self.push_frame(LLMFullResponseStartFrame())

        if self._script:
            tool_name, arguments = self._script.pop(0)
        else:
            tool_name = "finished"
            arguments = {"message": "Task complete", "status": "completed"}

        if self._thinking_text:
            await self.push_frame(LLMThoughtTextFrame(text=self._thinking_text))

        tool_call_id = f"call_{self._call_index}_{uuid.uuid4().hex[:8]}"
        self._call_index += 1

        function_call = FunctionCallFromLLM(
            function_name=tool_name,
            tool_call_id=tool_call_id,
            arguments=arguments,
            context=context,
        )
        await self.run_function_calls([function_call])
        await self.push_frame(LLMFullResponseEndFrame())

    async def run_inference(self, context, max_tokens=None, system_instruction=None):
        raise NotImplementedError("ScriptedLLMService doesn't support run_inference")


# ── E2EHarness ────────────────────────────────────────────────────────────


class E2EHarness:
    """End-to-end test harness with real agents, bus, and game server.

    Args:
        character_id: The test character's canonical UUID.
        edge_api: EdgeAPI instance for calling edge functions and polling events.
        make_game_client: Factory fixture for creating AsyncGameClient instances.
    """

    def __init__(self, character_id: str, edge_api, make_game_client):
        self.character_id = character_id
        self.api = edge_api
        self._make_game_client = make_game_client

        # Real game client
        self.game_client = make_game_client(character_id)

        # Real bus
        self.bus = AsyncQueueBus()

        # Mock RTVI (no real audio transport)
        self.rtvi = MagicMock()
        self.rtvi.push_frame = AsyncMock()

        # Real VoiceAgent
        self.voice_agent = VoiceAgent(
            "player",
            bus=self.bus,
            game_client=self.game_client,
            character_id=character_id,
            rtvi_processor=self.rtvi,
        )

        # Capture LLM frames from VoiceAgent
        self.llm_frames: list[LLMMessagesAppendFrame] = []
        original_queue = self.voice_agent.queue_frame_after_tools

        async def _capture_queue(frame):
            if isinstance(frame, LLMMessagesAppendFrame):
                self.llm_frames.append(frame)
            await original_queue(frame)

        self.voice_agent.queue_frame_after_tools = _capture_queue

        # Capture bus broadcasts (while still delivering to real bus)
        self.bus_events: list[dict] = []
        original_broadcast = self.voice_agent.broadcast_game_event

        async def _capture_broadcast(event):
            self.bus_events.append(event)
            await original_broadcast(event)

        self.voice_agent.broadcast_game_event = _capture_broadcast

        # Real EventRelay
        self.relay = EventRelay(
            game_client=self.game_client,
            rtvi_processor=self.rtvi,
            character_id=character_id,
            task_state=self.voice_agent,
        )
        self.voice_agent._event_relay = self.relay

        # Event cursor for polling
        self._event_cursor = 0

        # Task completion tracking
        self.task_responses: list[dict] = []
        self._original_on_task_response = self.voice_agent.on_task_response

        # Scripted LLM: when set, TaskAgent.build_llm returns this instead of real LLM
        self._task_llm_script: Optional[list[tuple[str, dict]]] = None
        self._task_llm_gate: Optional[asyncio.Event] = None
        self._original_build_llm = TaskAgent.build_llm

        def _build_llm_override(task_agent_self):
            if self._task_llm_script is not None:
                return ScriptedLLMService(
                    list(self._task_llm_script), gate=self._task_llm_gate
                )
            return self._original_build_llm(task_agent_self)

        TaskAgent.build_llm = _build_llm_override

    @property
    def llm_messages(self) -> list[tuple[str, bool]]:
        """Return (content, run_llm) pairs for all captured LLM frames."""
        return [(f.messages[0]["content"], f.run_llm) for f in self.llm_frames]

    @property
    def rtvi_push_count(self) -> int:
        return self.rtvi.push_frame.call_count

    def rtvi_events_of_type(self, event_type: str) -> list[dict]:
        """Extract RTVI push calls matching a given event type."""
        results = []
        for call in self.rtvi.push_frame.call_args_list:
            frame = call.args[0] if call.args else None
            if hasattr(frame, "data") and isinstance(frame.data, dict):
                if frame.data.get("event") == event_type:
                    results.append(frame.data)
        return results

    async def start_player_task(self, task_description: str = "Player task") -> dict:
        """Start a player ship task via VoiceAgent, returning the result dict."""
        from pipecat.services.llm_service import FunctionCallParams

        params = MagicMock(spec=FunctionCallParams)
        params.arguments = {"task_description": task_description}
        params.result_callback = AsyncMock()
        return await self.voice_agent._handle_start_task(params)

    async def start_corp_ship_task(
        self, ship_id: str, task_description: str = "Corp ship task"
    ) -> dict:
        """Start a corp ship task via VoiceAgent, returning the result dict."""
        from pipecat.services.llm_service import FunctionCallParams

        params = MagicMock(spec=FunctionCallParams)
        params.arguments = {"task_description": task_description, "ship_id": ship_id}
        params.result_callback = AsyncMock()
        return await self.voice_agent._handle_start_task(params)

    async def start(self, *, with_task_agents: bool = False):
        """Start the agent runner.

        Args:
            with_task_agents: If True, TaskAgent children spawned by
                VoiceAgent will have their pipelines built and started
                by the runner (needed for task E2E tests).
        """
        from gradientbang.subagents.runner import AgentRunner

        # Prevent VoiceAgent from needing a real LLM API key
        self.voice_agent.build_llm = lambda: ScriptedLLMService([])

        self._runner = AgentRunner(bus=self.bus)
        await self._runner.add_agent(self.voice_agent)
        self._runner_task = asyncio.create_task(self._runner.run())
        # Let the runner start agents
        await asyncio.sleep(0.2)

    def set_task_script(self, script: list[tuple[str, dict]]):
        """Set the scripted tool call sequence for the next TaskAgent."""
        self._task_llm_script = script

    async def stop(self):
        """Cancel the runner and clean up."""
        TaskAgent.build_llm = self._original_build_llm

        if self._runner:
            try:
                await self._runner.cancel(reason="test cleanup")
            except Exception:
                pass

        if self._runner_task and not self._runner_task.done():
            try:
                await asyncio.wait_for(self._runner_task, timeout=5.0)
            except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
                self._runner_task.cancel()
                try:
                    await self._runner_task
                except (asyncio.CancelledError, Exception):
                    pass

    async def join_game(self):
        """Join the game and feed initial events through the relay."""
        join_result = await self.api.call_ok("join", {"character_id": self.character_id})
        join_req_id = join_result.get("request_id")
        if join_req_id:
            self.voice_agent.track_request_id(join_req_id)

        # Issue megaport check
        mega_result = await self.api.call_ok(
            "list_known_ports",
            {"character_id": self.character_id, "mega": True, "max_hops": 100},
        )
        mega_req_id = mega_result.get("request_id")
        if mega_req_id:
            self.relay._megaport_check_request_id = mega_req_id

        # Feed initial events
        await self.poll_and_feed_events()
        return join_result

    async def poll_and_feed_events(self) -> list[dict]:
        """Poll for new events and feed them through the relay."""
        events = await self.api.events_since(
            self.character_id, since_event_id=self._event_cursor
        )
        for row in events:
            event_id = row.get("event_id", 0)
            if event_id > self._event_cursor:
                self._event_cursor = event_id
            await self.relay._relay_event(self._row_to_event(row))
        return events

    async def call_and_feed(self, endpoint: str, payload: dict) -> dict:
        """Call an edge function, poll events, feed through relay."""
        result = await self.api.call_ok(endpoint, payload)
        await self.poll_and_feed_events()
        return result

    async def inject_combat_event(
        self, combat_id: str, participants: list[dict], round_num: int = 1
    ):
        """Inject a combat.round_waiting event directly through the relay."""
        event = {
            "event_name": "combat.round_waiting",
            "payload": {
                "combat_id": combat_id,
                "round": round_num,
                "deadline": "2099-01-01T00:00:30Z",
                "participants": participants,
            },
        }
        await self.relay._relay_event(event)

    async def wait_for_task_complete(self, timeout: float = 30.0) -> bool:
        """Wait for a task to complete by polling events and checking state."""
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            await self.poll_and_feed_events()
            # Check if any task agent has finished
            for child in self.voice_agent.children:
                if isinstance(child, TaskAgent) and child._task_finished:
                    return True
            # Check if task groups are empty (task completed and cleaned up)
            if not self.voice_agent._task_groups:
                return True
            await asyncio.sleep(0.5)
        return False

    @staticmethod
    def _row_to_event(row: dict) -> dict:
        """Convert an events_since row to the format relay expects."""
        event: dict[str, Any] = {
            "event_name": row.get("event_type"),
            "payload": row.get("payload", {}),
        }
        if row.get("request_id"):
            event["request_id"] = row["request_id"]
        payload = event["payload"]
        if isinstance(payload, dict):
            ctx = row.get("event_context")
            if isinstance(ctx, dict) and ctx:
                payload["__event_context"] = ctx
        return event
