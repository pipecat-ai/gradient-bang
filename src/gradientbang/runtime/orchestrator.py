"""Per-session controller for a Gradient Bang bot.

Owns everything that needs to outlive a single LLM turn: the game client
(Supabase edge-function RPCs), the subagent bus (TaskAgent / UIAgent
comms), the event relay (game events → RTVI + LLM context), and
references to the bot.py-owned PipelineWorker and LLMContext.
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
from gradientbang.config import settings
from gradientbang.game.auth import Auth
from gradientbang.game.client import AsyncGameClient
from gradientbang.runtime.client_message_handlers import ClientMessageHandler
from gradientbang.runtime.event_relay import EventRelay
from gradientbang.runtime.session_init import gather_initial_state
from gradientbang.utils.prompt_loader import apply_prompt_substitutions, set_prompt_substitutions


class Orchestrator:
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
        """Register pipeline handles needed after construction."""
        assert self.game_client is not None, "game_client must be created first"
        assert self.auth.character_id is not None, "auth.character_id required"
        self.voice_worker = voice_worker
        self.context = context
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

    async def on_idle_report(self) -> bool:
        """Narrate background task progress on user silence.

        Returns True if a report was emitted, False to retry later.
        """
        return False

    async def handle_client_message(self, message) -> None:
        """Dispatch an inbound RTVI client message."""
        if self.client_messages is None:
            logger.debug(
                "Orchestrator.handle_client_message: unhandled {!r}; client handler not attached",
                getattr(message, "type", None),
            )
            return
        await self.client_messages.handle(message)

    # ── TaskStateProvider surface (consumed by EventRelay) ────────────

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

    @property
    def active(self) -> bool:
        """True while the orchestrator is accepting events."""
        return True

    async def queue_frame(self, frame) -> None:
        """Queue a frame into the voice pipeline worker."""
        if self.voice_worker is not None:
            await self.voice_worker.queue_frames([frame])

    # ── Event Handlers ────────────
