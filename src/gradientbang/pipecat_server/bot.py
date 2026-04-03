import asyncio
import os
import uuid

from dotenv import load_dotenv
from loguru import logger

BOT_INSTANCE_ID: str | None = None
DEFAULT_VOICE_ID = "ec1e269e-9ca0-402f-8a18-58e0e022355a"
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import (
    LLMFullResponseStartFrame,
    TTSUpdateSettingsFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMAssistantAggregatorParams,
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.processors.frameworks.rtvi import (
    RTVIProcessor,
    RTVIServerMessageFrame,
)
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.services.cartesia.tts import CartesiaTTSService
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.daily.transport import DailyParams
from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.utils.context.llm_context_summarization import (
    LLMAutoContextSummarizationConfig,
    LLMContextSummaryConfig,
)

from gradientbang.pipecat_server.s3_smart_turn import S3SmartTurnAnalyzerV3
from gradientbang.utils.llm_factory import (
    LLMProvider,
    LLMServiceConfig,
    create_llm_service,
    get_ui_agent_llm_config,
)
from gradientbang.utils.local_api_server import LocalApiServer
from gradientbang.utils.logging_config import configure_logging
from gradientbang.utils.prompt_loader import build_voice_agent_prompt, load_prompt

load_dotenv(dotenv_path=".env.bot")

from gradientbang.pipecat_server.client_message_handler import ClientMessageHandler
from gradientbang.pipecat_server.inference_gate import (
    InferenceGateState,
    PostLLMInferenceGate,
    PreLLMInferenceGate,
)
from gradientbang.pipecat_server.subagents.ui_agent import (
    UIAgentContext,
    UIAgentResponseCollector,
)
from gradientbang.pipecat_server.user_mute import TextInputBypassFirstBotMuteStrategy
from gradientbang.utils.supabase_client import AsyncGameClient
from gradientbang.utils.token_usage_logging import TokenUsageMetricsProcessor
from gradientbang.utils.weave_tracing import init_weave, traced

# Initialize Weave early (before @traced decorators are applied to startup functions).
# Must come after load_dotenv so WANDB_API_KEY is available.
init_weave()

if os.getenv("BOT_USE_KRISP"):
    from pipecat.audio.filters.krisp_viva_filter import KrispVivaFilter


async def _lookup_character_display_name(character_id: str, server_url: str) -> str | None:
    """Return the stored display name for a character ID via API lookup.

    Args:
        character_id: Character UUID to look up
        server_url: Game server base URL

    Returns:
        Character display name or None if not found
    """
    try:
        async with AsyncGameClient(
            base_url=server_url, character_id=character_id, transport="supabase"
        ) as client:
            result = await client.character_info(character_id=character_id)
            return result.get("name")
    except Exception as exc:
        logger.warning(f"Unable to lookup character {character_id} from server: {exc}")
        return None


async def _resolve_character_identity(
    character_id: str | None,
    server_url: str,
    character_name_hint: str | None = None,
) -> tuple[str, str]:
    """Resolve the character UUID and display name for the voice bot.

    Args:
        character_id: Optional character ID (will use env vars if not provided)
        server_url: Game server base URL for API lookups
        character_name_hint: Optional display name from the start payload (avoids DB lookup)

    Returns:
        Tuple of (character_id, display_name)
    """
    if character_id:
        logger.info(f"Resolving character identity for character_id: {character_id}")
    else:
        logger.info("No character_id provided, using environment variables")
        character_id = os.getenv("BOT_TEST_CHARACTER_ID") or os.getenv(
            "BOT_TEST_NPC_CHARACTER_NAME"
        )

    if not character_id:
        raise RuntimeError(
            "Set BOT_TEST_CHARACTER_ID (or BOT_TEST_NPC_CHARACTER_NAME) in the environment before starting the bot."
        )
    display_name = (
        character_name_hint
        or os.getenv("BOT_TEST_CHARACTER_NAME")
        or os.getenv("BOT_TEST_NPC_CHARACTER_NAME")
        or await _lookup_character_display_name(character_id, server_url)
        or character_id
    )
    return character_id, display_name


@traced
async def _startup_create_local_api_server() -> LocalApiServer:
    """Construct LocalApiServer instance (traced span)."""
    return LocalApiServer()


@traced
async def _startup_start_local_api_server(server: LocalApiServer) -> str:
    """Start LocalApiServer and wait for health check (traced span)."""
    return await server.start()


@traced
async def _startup_init_local_api() -> tuple[LocalApiServer, str]:
    """Create and start local API server (traced span)."""
    server = await _startup_create_local_api_server()
    url = await _startup_start_local_api_server(server)
    return server, url


@traced
async def _startup_resolve_character(
    character_id_hint: str | None, character_name_hint: str | None, server_url: str
):
    """Resolve character identity (traced span)."""
    return await _resolve_character_identity(
        character_id_hint, server_url, character_name_hint=character_name_hint
    )


@traced
async def _startup_init_stt():
    """Initialize STT service (traced span)."""
    return DeepgramSTTService(api_key=os.getenv("DEEPGRAM_API_KEY"))


@traced
async def _startup_init_tts(voice_id: str = DEFAULT_VOICE_ID):
    """Initialize TTS service (traced span)."""
    cartesia_key = os.getenv("CARTESIA_API_KEY", "")
    if not cartesia_key:
        logger.warning("CARTESIA_API_KEY is not set; TTS may fail.")
    return CartesiaTTSService(api_key=cartesia_key, voice_id=voice_id)


@traced
async def bot_startup(
    character_id_hint: str | None,
    character_name_hint: str | None,
    server_url: str,
    voice_id: str = DEFAULT_VOICE_ID,
):
    """Traced startup wrapper — initializes all services for the bot pipeline."""

    rtvi = RTVIProcessor()

    # Chain A: local API server → resolve character (sequential)
    # Chain B: STT + TTS init (independent)

    async def _chain_a():
        local_api_server: LocalApiServer | None = None
        if os.getenv("LOCAL_API_POSTGRES_URL"):
            local_api_server, local_api_url = await _startup_init_local_api()
            os.environ["EDGE_FUNCTIONS_URL"] = local_api_url
            logger.info(f"Using local API server: {local_api_url}")

            # Fire-and-forget warmup so Deno JIT-compiles the shared module
            # graph before the first real game API call.
            if character_id_hint:
                asyncio.create_task(local_api_server.warmup(character_id_hint))

        character_id, character_display_name = await _startup_resolve_character(
            character_id_hint,
            character_name_hint,
            server_url,
        )
        return local_api_server, character_id, character_display_name

    (local_api_server, character_id, character_display_name), stt, tts = await asyncio.gather(
        _chain_a(),
        _startup_init_stt(),
        _startup_init_tts(voice_id),
    )

    # Create game client directly
    game_client = AsyncGameClient(
        character_id=character_id,
        base_url=server_url,
        transport="supabase",
    )

    return rtvi, local_api_server, character_id, character_display_name, game_client, stt, tts


async def run_bot(transport, runner_args: RunnerArguments, **kwargs):
    """Main bot function that creates and runs the pipeline."""

    server_url = os.getenv("SUPABASE_URL")
    if not server_url:
        raise RuntimeError("SUPABASE_URL is required to run the bot.")
    logger.info(f"Using Supabase URL: {server_url}")

    body = getattr(runner_args, "body", None) or {}
    character_id_hint = body.get("character_id") or os.getenv("BOT_TEST_CHARACTER_ID")
    character_name_hint = body.get("character_name")
    voice_id = body.get("voice_id") or DEFAULT_VOICE_ID
    personality_tone = body.get("personality_tone", "").strip()

    (
        rtvi,
        local_api_server,
        character_id,
        character_display_name,
        game_client,
        stt,
        tts,
    ) = await bot_startup(character_id_hint, character_name_hint, server_url, voice_id)

    token_usage_metrics = TokenUsageMetricsProcessor(source="bot")

    # System prompt
    messages = [
        {
            "role": "system",
            "content": build_voice_agent_prompt(),
        },
    ]
    if personality_tone:
        messages.append(
            {
                "role": "system",
                "content": f"Adopt the following personality and tone for all responses: {personality_tone}",
            }
        )
    messages.append(
        {
            "role": "user",
            "content": f"<start_of_session>Character Name: {character_display_name}</start_of_session>",
        },
    )

    # Create dedicated Gemini Flash LLM for context summarization
    summarization_llm = create_llm_service(
        LLMServiceConfig(provider=LLMProvider.GOOGLE, model="gemini-2.5-flash")
    )
    message_limit = int(os.getenv("CONTEXT_SUMMARIZATION_MESSAGE_LIMIT", "200"))
    auto_summarization_config = LLMAutoContextSummarizationConfig(
        max_context_tokens=None,
        max_unsummarized_messages=message_limit,
        summary_config=LLMContextSummaryConfig(
            target_context_tokens=6000,
            min_messages_after_summary=5,
            summarization_prompt=load_prompt("fragments/context_summarization.md"),
            summary_message_template="<session_history_summary>\n{summary}\n</session_history_summary>",
            llm=summarization_llm,
            summarization_timeout=120.0,
        ),
    )

    # Context starts empty — messages and tools are injected into the
    # VoiceAgent via LLMAgentActivationArgs on the bus.
    context = LLMContext()
    mute_strategy = TextInputBypassFirstBotMuteStrategy()
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            filter_incomplete_user_turns=True,
            user_turn_strategies=UserTurnStrategies(
                stop=[
                    TurnAnalyzerUserTurnStopStrategy(
                        turn_analyzer=S3SmartTurnAnalyzerV3(player_id=character_id)
                    )
                ],
            ),
            user_mute_strategies=[
                mute_strategy,
            ],
            vad_analyzer=SileroVADAnalyzer(),
        ),
        assistant_params=LLMAssistantAggregatorParams(
            enable_auto_context_summarization=True,
            auto_context_summarization_config=auto_summarization_config,
        ),
    )
    # The aggregator defaults _user_is_muted to False. When the mute strategy
    # first evaluates and returns "muted", the False→True transition emits a
    # UserMuteStartedFrame before the pipeline is fully started, which can
    # cause errors in parallel branch sources. Seed to True so no transition
    # fires during startup.
    if hasattr(user_aggregator, "_user_is_muted"):
        user_aggregator._user_is_muted = True

    user_mute_state = {"muted": True}
    user_unmuted_event = asyncio.Event()
    say_text_restore_voice: dict[str, str | None] = {"voice_id": None}

    class SayTextVoiceGuard(FrameProcessor):
        """Restores the original TTS voice before normal LLM speech.

        When say-text sets a temporary voice, the queued restore frame can be
        cancelled by an interruption. This guard sits before TTS and ensures
        the voice is always restored when normal LLM-driven speech begins.
        """

        def __init__(self, restore_state: dict):
            super().__init__()
            self._restore_state = restore_state

        async def process_frame(self, frame, direction: FrameDirection):
            await super().process_frame(frame, direction)
            if isinstance(frame, LLMFullResponseStartFrame):
                restore_id = self._restore_state.get("voice_id")
                if restore_id:
                    logger.info(f"SayTextVoiceGuard: restoring voice to {restore_id}")
                    self._restore_state["voice_id"] = None
                    await self.push_frame(TTSUpdateSettingsFrame(settings={"voice_id": restore_id}))
            await self.push_frame(frame, direction)

    say_text_voice_guard = SayTextVoiceGuard(say_text_restore_voice)

    # ── Voice context upload state ────────────────────────────────────
    from gradientbang.pipecat_server.context_upload import upload_context as _upload_context

    _voice_ctx_seq = 1  # Sequence number; increments on compaction
    _voice_ctx_last_uploaded_count = 0  # Message count at last upload; skip if unchanged

    def _upload_voice_context(reason: str) -> None:
        nonlocal _voice_ctx_seq, _voice_ctx_last_uploaded_count
        msgs = list(context.get_messages())
        if not msgs:
            return
        if reason == "periodic" and len(msgs) == _voice_ctx_last_uploaded_count:
            return  # Nothing changed
        session_id = BOT_INSTANCE_ID or "unknown"
        s3_key = f"contexts/{character_id}/{session_id}/voice/{_voice_ctx_seq:04d}.json"
        _voice_ctx_last_uploaded_count = len(msgs)
        _upload_context(
            s3_key=s3_key,
            messages=msgs,
            db_row={
                "character_id": character_id,
                "session_id": session_id,
                "snapshot_type": "voice",
                "s3_key": s3_key,
                "message_count": len(msgs),
                "snapshot_reason": reason,
            },
        )

    @assistant_aggregator.event_handler("on_summary_applied")
    async def on_summary_applied(aggregator, summarizer, event):
        nonlocal _voice_ctx_seq
        logger.info(
            f"Context summarized: {event.original_message_count} -> "
            f"{event.new_message_count} messages "
            f"({event.summarized_message_count} compressed, "
            f"{event.preserved_message_count} preserved)"
        )
        # Upload pre-compaction era, then bump sequence for the new era
        try:
            _upload_voice_context("compaction")
        except Exception as exc:
            logger.error(f"Compaction voice context upload failed: {exc}")
        _voice_ctx_seq += 1
        await rtvi.push_frame(
            RTVIServerMessageFrame(
                {
                    "frame_type": "event",
                    "event": "llm.context_summarized",
                    "payload": {
                        "original_message_count": event.original_message_count,
                        "new_message_count": event.new_message_count,
                        "summarized_message_count": event.summarized_message_count,
                        "preserved_message_count": event.preserved_message_count,
                    },
                }
            )
        )

    @user_aggregator.event_handler("on_user_mute_started")
    async def on_user_mute_started(aggregator):
        logger.info("User input muted")
        user_mute_state["muted"] = True
        user_unmuted_event.clear()

    @user_aggregator.event_handler("on_user_mute_stopped")
    async def on_user_mute_stopped(aggregator):
        logger.info("User input unmuted")
        user_mute_state["muted"] = False
        user_unmuted_event.set()

    inference_gate_state = InferenceGateState(
        cooldown_seconds=2,
        post_llm_grace_seconds=1.5,
    )
    pre_llm_gate = PreLLMInferenceGate(inference_gate_state)
    post_llm_gate = PostLLMInferenceGate(inference_gate_state)

    # Create UI agent branch components (3-processor design)
    ui_agent_config = get_ui_agent_llm_config()
    ui_agent_context = UIAgentContext(
        config=ui_agent_config,
        rtvi=rtvi,
        game_client=game_client,
    )
    ui_llm = create_llm_service(ui_agent_config)
    ui_llm.register_function("control_ui", ui_agent_context.handle_control_ui)
    ui_llm.register_function("queue_ui_intent", ui_agent_context.handle_queue_ui_intent)
    ui_llm.register_function("corporation_info", ui_agent_context.handle_corporation_info)
    ui_llm.register_function("my_status", ui_agent_context.handle_my_status)
    ui_response_collector = UIAgentResponseCollector(context=ui_agent_context)

    ui_branch: list[FrameProcessor] = [ui_agent_context, ui_llm, ui_response_collector]
    ui_branch_sources = set(ui_branch)

    # ── Create subagents and wire everything together ───────────────────

    from pipecat.frames.frames import BotSpeakingFrame, UserSpeakingFrame
    from pipecat.pipeline.parallel_pipeline import ParallelPipeline
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.task import PipelineParams, PipelineTask
    from pipecat.processors.frameworks.rtvi import (
        RTVIFunctionCallReportLevel,
        RTVIObserver,
        RTVIObserverParams,
    )

    from gradientbang.pipecat_server.frames import TaskActivityFrame
    from gradientbang.pipecat_server.idle_report import IdleReportProcessor
    from gradientbang.pipecat_server.subagents.event_relay import EventRelay
    from gradientbang.pipecat_server.subagents.scripted_agent import ScriptedAgent
    from gradientbang.pipecat_server.subagents.voice_agent import VoiceAgent
    from gradientbang.subagents.agents import BaseAgent, LLMAgentActivationArgs
    from gradientbang.subagents.bus import BusBridgeProcessor
    from gradientbang.subagents.runner import AgentRunner
    from gradientbang.subagents.types import AgentReadyData

    class MainAgent(BaseAgent):
        """Transport agent — bridges voice I/O to VoiceAgent via the bus.

        Defined inline so it can capture processors from the enclosing scope
        instead of receiving them as constructor parameters.
        """

        def __init__(self, name, *, bus):
            super().__init__(name, bus=bus)

        async def on_agent_ready(self, data: AgentReadyData) -> None:
            await super().on_agent_ready(data)
            logger.info(f"MainAgent: {data.agent_name} ready")

        def build_pipeline_task(self, pipeline: Pipeline) -> PipelineTask:
            task = PipelineTask(
                pipeline,
                params=PipelineParams(
                    enable_metrics=True,
                    enable_usage_metrics=True,
                ),
                rtvi_processor=rtvi,
                rtvi_observer_params=RTVIObserverParams(
                    function_call_report_level={
                        "*": RTVIFunctionCallReportLevel.FULL,
                    },
                ),
                cancel_on_idle_timeout=False,
                idle_timeout_secs=600,
                idle_timeout_frames=(
                    BotSpeakingFrame,
                    UserSpeakingFrame,
                    TaskActivityFrame,
                ),
            )
            for obs in task._observer._observers:
                if isinstance(obs, RTVIObserver):
                    obs._ignored_sources = ui_branch_sources
                    break
            return task

        async def build_pipeline(self) -> Pipeline:
            bridge = BusBridgeProcessor(
                bus=self.bus,
                agent_name=self.name,
                name=f"{self.name}::BusBridge",
            )

            @transport.event_handler("on_client_connected")
            async def on_client_connected(transport, client):
                logger.info("Client connected, adding agents")
                await self.add_agent(voice_agent)
                await self.add_agent(scripted_agent)

            return Pipeline(
                [
                    transport.input(),
                    stt,
                    idle_report_processor,
                    pre_llm_gate,
                    user_aggregator,
                    ParallelPipeline(
                        [
                            bridge,
                            post_llm_gate,
                            token_usage_metrics,
                            say_text_voice_guard,
                            tts,
                            transport.output(),
                            assistant_aggregator,
                        ],
                        ui_branch,
                    ),
                ]
            )

    agent_runner = AgentRunner(handle_sigint=getattr(runner_args, "handle_sigint", False))

    voice_agent = VoiceAgent(
        "player",
        bus=agent_runner.bus,
        game_client=game_client,
        character_id=character_id,
        rtvi_processor=rtvi,
    )

    event_relay = EventRelay(
        game_client=game_client,
        rtvi_processor=rtvi,
        character_id=character_id,
        task_state=voice_agent,
    )
    voice_agent._event_relay = event_relay

    async def _on_tutorial_complete():
        logger.info("Tutorial complete, switching to VoiceAgent")
        await main_agent.deactivate_agent("scripted")
        # Reset mute strategy so the normal first-bot-speech logic applies fresh.
        # Release force_mute AFTER deactivating scripted agent to avoid any
        # in-flight BotStoppedSpeakingFrame from the tutorial triggering unmute.
        await mute_strategy.reset()
        mute_strategy.force_mute = False
        await main_agent.activate_agent(
            "player",
            args=LLMAgentActivationArgs(messages=messages, run_llm=True),
        )

    scripted_agent = ScriptedAgent(
        "scripted",
        bus=agent_runner.bus,
        rtvi_processor=rtvi,
        on_complete=_on_tutorial_complete,
    )

    idle_report_processor = IdleReportProcessor(
        idle_seconds=float(os.getenv("BOT_IDLE_REPORT_TIME", "7.5")),
        cooldown_seconds=float(os.getenv("BOT_IDLE_REPORT_COOLDOWN", "30")),
        on_idle=voice_agent.on_idle_report,
        enabled=os.getenv("BOT_IDLE_REPORT_ENABLED", "1") not in ("0", "false", ""),
    )

    main_agent = MainAgent("main", bus=agent_runner.bus)
    await agent_runner.add_agent(main_agent)

    # ── Event handlers ─────────────────────────────────────────────────

    is_first_visit = False

    @rtvi.event_handler("on_client_ready")
    async def on_client_ready(rtvi):
        nonlocal is_first_visit

        async def _join():
            nonlocal is_first_visit
            await asyncio.sleep(2)
            await game_client.pause_event_delivery()
            result = await event_relay.join()
            # Track join request_id so the resulting status.snapshot triggers LLM inference
            if isinstance(result, dict):
                req_id = result.get("request_id")
                if req_id:
                    voice_agent.track_request_id(req_id)
                is_first_visit = bool(result.get("is_first_visit", False))
            await game_client.resume_event_delivery()

            # Activate the correct agent based on first visit status
            if is_first_visit:
                logger.info("First visit detected, activating ScriptedAgent")
                mute_strategy.force_mute = True
                event_relay._onboarding_complete = True
                await main_agent.activate_agent("scripted")
            else:
                await main_agent.activate_agent(
                    "player",
                    args=LLMAgentActivationArgs(messages=messages, run_llm=False),
                )

        asyncio.create_task(_join())

    client_message_handler = ClientMessageHandler(
        game_client=game_client,
        character_id=character_id,
        rtvi=rtvi,
        transport=transport,
        main_agent=main_agent,
        tts=tts,
        say_text_restore_voice=say_text_restore_voice,
        user_mute_state=user_mute_state,
        user_unmuted_event=user_unmuted_event,
        llm_context=context,
        voice_agent=voice_agent,
        on_skip_tutorial=_on_tutorial_complete,
    )

    @rtvi.event_handler("on_client_message")
    async def on_client_message(rtvi, message):
        await client_message_handler.handle(message)

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Client disconnected")
        await main_agent.cancel()

    # ── Periodic voice context upload (every 10 minutes) ─────────────

    _periodic_upload_task: asyncio.Task | None = None

    async def _periodic_voice_context_upload():
        while True:
            await asyncio.sleep(600)
            try:
                _upload_voice_context("periodic")
            except Exception as exc:
                logger.error(f"Periodic voice context upload failed: {exc}")

    # ── Run ────────────────────────────────────────────────────────────

    try:
        _periodic_upload_task = asyncio.create_task(_periodic_voice_context_upload())
        logger.info("Starting AgentRunner…")
        await agent_runner.run()
        logger.info("AgentRunner finished")
    except asyncio.CancelledError:
        logger.info("AgentRunner cancelled")
        raise
    except Exception as e:
        logger.exception(f"AgentRunner error: {e}")
    finally:
        if _periodic_upload_task is not None:
            _periodic_upload_task.cancel()
        try:
            _upload_voice_context("shutdown")
        except Exception as exc:
            logger.error(f"Shutdown voice context upload failed: {exc}")
        try:
            await voice_agent.close_tasks()
        except Exception as exc:
            logger.error(f"Player agent task cleanup failed: {exc}")
        try:
            await event_relay.close()
        except Exception as exc:
            logger.error(f"Event relay close failed: {exc}")
        try:
            await game_client.close()
        except Exception as exc:
            logger.error(f"Game client close failed: {exc}")
        if local_api_server is not None:
            try:
                await local_api_server.stop()
            except Exception as exc:
                logger.error(f"Local API server stop failed: {exc}")


async def bot(runner_args: RunnerArguments):
    """Main bot entry point"""
    global BOT_INSTANCE_ID
    # Use Pipecat Cloud session_id when available, otherwise generate one.
    BOT_INSTANCE_ID = getattr(runner_args, "session_id", None) or uuid.uuid4().hex
    os.environ["BOT_INSTANCE_ID"] = BOT_INSTANCE_ID

    configure_logging(instance_id=BOT_INSTANCE_ID)

    logger.info(f"Bot started with runner_args: {runner_args}")

    transport_params = {
        "daily": lambda: DailyParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_filter=(KrispVivaFilter() if os.getenv("BOT_USE_KRISP") else None),
        ),
        "webrtc": lambda: TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_filter=(KrispVivaFilter() if os.getenv("BOT_USE_KRISP") else None),
        ),
    }

    transport = await create_transport(runner_args, transport_params)
    await run_bot(transport, runner_args)


if __name__ == "__main__":
    from pipecat.runner.run import main

    main()
