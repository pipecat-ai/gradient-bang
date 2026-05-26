"""Per-session orchestrator for a Gradient Bang bot.

Owns session-level glue: game I/O, event relay, client messages, and the
Pipecat worker host used by task agents.
"""

from __future__ import annotations

from typing import Any, Dict

from loguru import logger
from pipecat.frames.frames import LLMMessagesAppendFrame
from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frameworks.rtvi import RTVIProcessor, RTVIServerMessageFrame

from gradientbang import __version__
from gradientbang.adapters.bus import AgentBus, make_subagent_bus
from gradientbang.config import PLAYER_AGENT_NAME, settings
from gradientbang.game.auth import Auth
from gradientbang.game.client import AsyncGameClient
from gradientbang.runtime.client_message_handlers import ClientMessageHandler
from gradientbang.runtime.event_relay import EventRelay
from gradientbang.runtime.session_init import gather_initial_state
from gradientbang.utils.prompt_loader import apply_prompt_substitutions, set_prompt_substitutions


class Orchestrator:
    # ── Runtime Setup ────────────────────────────────────────────────

    def __init__(
        self,
        *,
        auth: Auth,
        session_id: str,
        local_api_url: str | None,
        rtvi: RTVIProcessor,
    ) -> None:
        self.auth = auth
        self.session_id = session_id
        self.local_api_url = local_api_url
        self.rtvi = rtvi
        self.bus: AgentBus | None = None
        self.voice_worker: PipelineWorker | None = None
        self.game_client: AsyncGameClient | None = None
        self.event_relay: EventRelay | None = None
        self.context: LLMContext | None = None
        self.client_messages: ClientMessageHandler | None = None
        self._worker_event_bridge_installed = False

    @classmethod
    async def create(
        cls,
        *,
        auth: Auth,
        session_id: str,
        local_api_url: str | None,
        rtvi: RTVIProcessor,
    ) -> "Orchestrator":
        orch = cls(
            auth=auth,
            session_id=session_id,
            local_api_url=local_api_url,
            rtvi=rtvi,
        )
        # AsyncGameClient construction is pure-config — no IO until the first
        # RPC. base_url comes from settings.SUPABASE_URL; functions_url is the
        # in-process Deno server when LOCAL_API_POSTGRES_URL is set.
        orch.game_client = AsyncGameClient(
            character_id=auth.character_id,
            base_url=settings.SUPABASE_URL,
            functions_url=local_api_url,
            access_token=auth.access_token,
        )
        # EventRelay only registers handlers on game_client at construction;
        # no IO. The orchestrator satisfies TaskStateProvider directly.
        orch.event_relay = EventRelay(
            game_client=orch.game_client,
            rtvi_processor=rtvi,
            character_id=auth.character_id,
            task_state=orch,
        )
        logger.info(f"Orchestrator created session_id={session_id}")
        return orch

    def attach(
        self,
        *,
        voice_worker: PipelineWorker,
        context: LLMContext,
        transport,
    ) -> None:
        """Register runtime handles owned by bot.py."""
        assert self.game_client is not None, "game_client must be created first"
        assert self.auth.character_id is not None, "auth.character_id required"
        if voice_worker.name != PLAYER_AGENT_NAME:
            raise ValueError(
                f"voice_worker must be named {PLAYER_AGENT_NAME!r}; got {voice_worker.name!r}"
            )
        self.voice_worker = voice_worker
        self.context = context
        self._install_worker_event_bridge(voice_worker)
        self.client_messages = ClientMessageHandler(
            game_client=self.game_client,
            character_id=self.auth.character_id,
            rtvi=self.rtvi,
            transport=transport,
            pipeline_worker=voice_worker,
            llm_context=context,
        )

    async def create_bus(self) -> AgentBus:
        """Construct the subagent bus. Raises on init failure (e.g. PGMQ unreachable)."""
        self.bus = await make_subagent_bus()
        return self.bus

    # ── Worker Host Facade ────────────────────────────────────────────

    def _require_voice_worker(self) -> PipelineWorker:
        if self.voice_worker is None:
            raise RuntimeError("voice worker is not attached")
        return self.voice_worker

    @property
    def name(self) -> str:
        """Bus identity used by player-owned task agents."""
        if self.voice_worker is None:
            return PLAYER_AGENT_NAME
        return self.voice_worker.name

    @property
    def active(self) -> bool:
        """True while the player worker is accepting events."""
        if self.voice_worker is None:
            return True
        return self.voice_worker.active

    @property
    def children(self):
        return self._require_voice_worker().children

    @property
    def job_groups(self):
        return self._require_voice_worker().job_groups

    @property
    def registry(self):
        return self._require_voice_worker().registry

    async def send_bus_message(self, message) -> None:
        await self._require_voice_worker().send_bus_message(message)

    async def add_worker(self, worker) -> None:
        await self._require_voice_worker().add_worker(worker)

    async def watch_worker(self, worker_name: str) -> None:
        await self._require_voice_worker().watch_worker(worker_name)

    async def cancel_job_group(self, job_id: str, *, reason: str | None = None) -> None:
        await self._require_voice_worker().cancel_job_group(job_id, reason=reason)

    async def request_job_update(self, job_id: str, worker_name: str) -> None:
        await self._require_voice_worker().request_job_update(job_id, worker_name)

    def create_task(self, *args, **kwargs):
        return self._require_voice_worker().create_task(*args, **kwargs)

    async def cancel_task(self, *args, **kwargs) -> None:
        await self._require_voice_worker().cancel_task(*args, **kwargs)

    async def queue_frame(self, frame) -> None:
        """Queue a frame into the player voice pipeline."""
        if self.voice_worker is not None:
            await self.voice_worker.queue_frames([frame])

    # ── Worker Event Bridge ───────────────────────────────────────────

    def _install_worker_event_bridge(self, voice_worker: PipelineWorker) -> None:
        if self._worker_event_bridge_installed:
            return

        @voice_worker.event_handler("on_worker_ready")
        async def _orchestrator_worker_ready(_worker, data) -> None:
            await self.on_worker_ready(data)

        @voice_worker.event_handler("on_worker_failed")
        async def _orchestrator_worker_failed(_worker, data) -> None:
            await self.on_worker_failed(data)

        @voice_worker.event_handler("on_job_update")
        async def _orchestrator_job_update(_worker, message) -> None:
            await self.on_job_update(message)

        @voice_worker.event_handler("on_job_response")
        async def _orchestrator_job_response(_worker, message) -> None:
            await self.on_job_response(message)

        @voice_worker.event_handler("on_bus_message")
        async def _orchestrator_bus_message(_worker, message) -> None:
            await self.on_bus_message(message)

        self._worker_event_bridge_installed = True

    async def on_worker_ready(self, data) -> None:
        logger.info(f"{self.name}: {data.worker_name} ready")

    async def on_worker_failed(self, data) -> None:
        logger.warning(
            f"{self.name}: {getattr(data, 'worker_name', '<unknown>')} failed: "
            f"{getattr(data, 'error', '<unknown>')}"
        )

    async def on_job_update(self, message) -> None:
        logger.trace(
            f"{self.name}: job update from {getattr(message, 'source', '<unknown>')} "
            f"job={getattr(message, 'job_id', '<unknown>')}"
        )

    async def on_job_response(self, message) -> None:
        logger.trace(
            f"{self.name}: job response from {getattr(message, 'source', '<unknown>')} "
            f"job={getattr(message, 'job_id', '<unknown>')}"
        )

    async def on_bus_message(self, message) -> None:
        logger.trace(f"{self.name}: bus message {type(message).__name__}")

    # ── Join / Session Bootstrap ─────────────────────────────────────

    async def join(self) -> None:
        """Run the post-`on_client_ready` session bootstrap.

        Opens event delivery, fetches initial state, patches the system
        prompt, broadcasts bootstrap events to the client, injects initial
        messages into the LLM context, and starts event consumption.
        """
        assert self.game_client is not None, "game_client must be created first"
        assert self.event_relay is not None, "event_relay must be created first"
        assert self.auth.character_id is not None, "auth.character_id required"
        assert self.auth.display_name is not None, "auth.display_name required"

        # Old bot.py slept 2s here, ostensibly to let the RTVI handshake
        # settle before bootstrap RPCs fire. Re-enable if startup races appear.
        # await asyncio.sleep(2)

        # Open the event-delivery subscription. Under EVENT_TRANSPORT=pubsub
        # this is where the PGMQ subscription is actually created; failures
        # here mean DB / wrapper / role grants aren't right and we should
        # bail loud rather than half-join.
        try:
            await self.game_client.prepare_event_delivery_for_bootstrap()
        except Exception as exc:
            logger.exception(f"Event delivery prepare failed: {exc}")
            raise

        initial_state = await gather_initial_state(
            game_client=self.game_client,
            character_id=self.auth.character_id,
            character_display_name=self.auth.display_name,
            bypass_tutorial=True,
        )

        # Patch ${universe_size} / ${fedspace_sector_count} into the system
        # message now that we have the resolved values from status.snapshot.
        subs: dict[str, str | int] = {}
        if initial_state.universe_size is not None:
            subs["universe_size"] = initial_state.universe_size
        if initial_state.fedspace_sector_count is not None:
            subs["fedspace_sector_count"] = initial_state.fedspace_sector_count
        if subs:
            set_prompt_substitutions(**subs)
            if self.context is not None:
                for msg in self.context.messages:
                    if msg.get("role") == "system":
                        msg["content"] = apply_prompt_substitutions(msg["content"])
                        break
            else:
                logger.warning(
                    "Orchestrator.join: no context attached — prompt "
                    "substitutions resolved but not applied to system message"
                )

        await self.event_relay.attach_session_state(
            session_started_at=initial_state.session_started_at,
            display_name=initial_state.display_name,
            is_new_player=initial_state.is_new_player,
        )

        # Hydrate the web client with the same bootstrap data used for the
        # initial LLM context. The map.local handler requires the bound
        # player id, so inject it here.
        map_local_payload = {
            **initial_state.map_local_payload,
            "player": {"id": self.auth.character_id},
        }
        await self._emit_client_event("status.snapshot", initial_state.status_payload)
        await self._emit_client_event("map.local", map_local_payload)
        await self._emit_client_event(
            "ships.list", {"ships": initial_state.ships_payload.get("ships", [])}
        )
        await self._emit_client_event(
            "quest.status", {"quests": initial_state.quest_payload.get("quests", [])}
        )

        await self._emit_client_event("session.version", {"version": __version__})

        # Keep non-bootstrap events that arrived during startup; we'll
        # replay them once consumption is active.
        await self.game_client.complete_event_delivery_bootstrap()

        # Inject the initial messages assembled by session_init into the
        # voice LLM's context. We append without run_llm — the caller
        # (bot.py) fires the LLM via LLMRunFrame after join() returns.
        if self.voice_worker is not None and initial_state.initial_messages:
            await self.voice_worker.queue_frames(
                [LLMMessagesAppendFrame(messages=initial_state.initial_messages)]
            )
        elif initial_state.initial_messages:
            logger.warning(
                "Orchestrator.join: no voice worker attached — initial messages "
                "not injected into LLM context"
            )

        # Discard bootstrap echoes, replay non-bootstrap events queued during
        # startup, then flip the adapter into active consumption mode.
        try:
            await self.game_client.replay_event_delivery_catchup()
            await self.game_client.start_event_delivery()
        except Exception as exc:
            logger.exception(f"Event delivery activation failed: {exc}")
            raise

        logger.info("Orchestrator.join: event delivery active")

    async def _emit_client_event(self, event_name: str, payload: Dict[str, Any]) -> None:
        await self.rtvi.push_frame(
            RTVIServerMessageFrame(
                {
                    "frame_type": "event",
                    "event": event_name,
                    "payload": payload,
                }
            )
        )

    # ── Client Messages ──────────────────────────────────────────────

    async def handle_client_message(self, message) -> None:
        """Dispatch an inbound RTVI client message."""
        if self.client_messages is None:
            logger.debug(
                "Orchestrator.handle_client_message: unhandled {!r}; client handler not attached",
                getattr(message, "type", None),
            )
            return
        await self.client_messages.handle(message)

    # ── Event Relay Surface ──────────────────────────────────────────

    async def broadcast_game_event(
        self, event: Dict[str, Any], *, voice_agent_originated: bool = False
    ) -> None:
        """Fan a game event out to TaskAgent children via the bus."""

    def is_our_task(self, task_id: str) -> bool:
        """True if the given task id belongs to this session."""
        return False

    def active_tasks_summary(self) -> str:
        """Human-readable summary of active tasks, appended to status snapshots."""
        return ""

    def update_polling_scope(self) -> None:
        """Refresh the set of characters the game client polls events for."""

    def is_recent_request_id(self, request_id: str) -> bool:
        """True if the request id is a recent LLM-originated RPC echo."""
        return False

    @property
    def tool_call_active(self) -> bool:
        """True while an LLM tool call is in flight."""
        return False

    # ── Idle reporting ───────────────────────────────────────────────

    async def on_idle_report(self) -> bool:
        """Narrate background task progress on user silence.

        Returns True if a report was emitted, False to retry later.
        """
        return False

    # ── Shutdown ─────────────────────────────────────────────────────

    async def close_tasks(self) -> None:
        """Drain in-flight TaskAgent subworkers before resource teardown."""

    async def close(self) -> None:
        """Tear down session-owned resources."""
        if self.event_relay is not None:
            try:
                await self.event_relay.close()
            except Exception as exc:
                logger.error(f"Event relay close failed: {exc}")
            self.event_relay = None
        if self.game_client is not None:
            try:
                await self.game_client.close()
            except Exception as exc:
                logger.error(f"Game client close failed: {exc}")
            self.game_client = None
