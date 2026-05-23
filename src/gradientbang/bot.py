import asyncio
import os
import uuid

from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import BotSpeakingFrame, LLMRunFrame, UserSpeakingFrame
from pipecat.pipeline.parallel_pipeline import (
    ParallelPipeline,  # noqa: F401  (UI branch lands later)
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMAssistantAggregatorParams,
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frameworks.rtvi import (
    RTVIFunctionCallReportLevel,
    RTVIObserverParams,
    RTVIProcessor,
    RTVIServerMessageFrame,
)
from pipecat.registry.types import WorkerReadyData
from pipecat.runner.types import DailyRunnerArguments, RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.transcriptions.language import Language
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.daily.transport import DailyParams
from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.utils.context.llm_context_summarization import (
    LLMAutoContextSummarizationConfig,
    LLMContextSummaryConfig,
)

from gradientbang import STARTUP_BANNER, __version__
from gradientbang.config import settings
from gradientbang.game.auth import Auth, AuthError
from gradientbang.game.local_api_server import LocalApiServer
from gradientbang.pipecat_server.frames import TaskActivityFrame
from gradientbang.pipecat_server.idle_report import IdleReportProcessor
from gradientbang.pipecat_server.inference_gate import (
    InferenceGateState,
    PostLLMInferenceGate,
    PreLLMInferenceGate,
)
from gradientbang.pipecat_server.s3_smart_turn import S3SmartTurnAnalyzerV3
from gradientbang.pipecat_server.user_mute import TextInputBypassFirstBotMuteStrategy
from gradientbang.runtime.context_upload import VoiceContextUploader
from gradientbang.runtime.daily_recording import (
    configure_recording_bucket,
    start_raw_tracks_recording,
)
from gradientbang.runtime.models import BotRuntimeConfig, BotRuntimeState
from gradientbang.runtime.orchestrator import Orchestrator
from gradientbang.runtime.voices import (
    DEFAULT_PERSONALITY_TONE,
    DEFAULT_VOICE,
    get_default_voice_id,
    get_voice_config,
)
from gradientbang.utils.cekura_tracing import get_tracer, init_cekura, is_cekura_enabled
from gradientbang.utils.llm_factory import (
    LLMProvider,
    LLMServiceConfig,
    create_llm_service,
    get_voice_llm_config,
)
from gradientbang.utils.logging_config import configure_logging
from gradientbang.utils.prompt_loader import (
    build_voice_agent_prompt,
    load_prompt,
    set_prompt_substitutions,
)
from gradientbang.utils.stt_factory import create_stt_service, get_stt_config
from gradientbang.utils.token_usage_logging import TokenUsageMetricsProcessor
from gradientbang.utils.tts_factory import create_tts_service, get_tts_config, get_tts_provider
from gradientbang.utils.weave_tracing import init_weave, traced

if settings.BOT_USE_KRISP:
    from pipecat.audio.filters.krisp_viva_filter import KrispVivaFilter

BOT_INSTANCE_ID: str | None = None

# Initialize Weave early (before @traced decorators are applied to startup functions).
# Must come after load_dotenv so WANDB_API_KEY is available.
init_weave()
init_cekura()


# ─── Bot code ────────────────────────────────────────────────────────────────


async def run_bot(transport, runner_args: RunnerArguments) -> None:
    # ── Auth ──────────────────────────────────────────────────────────
    # Do this first since the bot can't do anything without a valid JWT, early exit
    body = getattr(runner_args, "body", None) or {}
    auth = Auth(
        character_id=body.get("character_id"),
        access_token=body.get("access_token"),
        character_name_hint=body.get("character_name"),
    )
    try:
        await auth.authenticate()
    except AuthError as exc:
        logger.error(f"Authentication failed: {exc}")
        # @TODO: how should we cleanly bail from a session here? Transport cleanup, etc?
        return

    logger.opt(colors=True).info(
        "<blue>▶▶▶ Authentication successful, proceeding with initialization...</blue>"
    )

    # ── Session config ─────────────────────────────────────────────────
    config = BotRuntimeConfig.from_body(body)

    tts_provider = get_tts_provider()
    voice_config = get_voice_config(config.voice_name, tts_provider) if config.voice_name else None
    if voice_config:
        active_voice_name = config.voice_name
        voice_id = voice_config["voice_id"]
        language = Language(voice_config["language"])
    else:
        active_voice_name = DEFAULT_VOICE
        voice_id = config.voice_id_hint or get_default_voice_id(tts_provider)
        language = Language.EN

    # ── Parallel init ──────────────────────────────────────────────────
    # Race independent slow I/O so cold-start ≈ max(task) instead of
    # sum(task). Without this, Deno boot + STT/TTS provider handshakes
    # stack serially and tack ~2-5s onto every session start. Each task
    # is @traced so per-component timing shows up as its own Weave span.

    # When LOCAL_API_POSTGRES_URL is set, spin up an embedded Deno subprocess
    # running the edge functions in-process — this is the prod setup, used to
    # skip the round-trip to Supabase's hosted functions for every RPC. Returns
    # None otherwise (rare — some test/eval configs hitting Supabase directly).
    @traced
    async def _init_local_api() -> LocalApiServer | None:
        if not settings.LOCAL_API_POSTGRES_URL:
            return None
        server = LocalApiServer()
        await server.start()
        logger.info(f"Using local API server: {server.url}")
        # Fire-and-forget warmup so Deno JIT-compiles the shared module graph
        # before the first real game RPC. Detached on purpose.
        asyncio.create_task(server.warmup(auth.character_id))
        return server

    @traced
    async def _init_stt():
        return create_stt_service(get_stt_config(language=language))

    @traced
    async def _init_tts():
        return create_tts_service(get_tts_config(voice_id=voice_id, language=language))

    # Same clean-bail pattern as auth: if any init task raises, log and
    # return — no noisy traceback. Siblings keep running briefly after one
    # fails (gather doesn't auto-cancel), but Deno boot is the only slow
    # task here and self-cleans when the bot process exits.
    try:
        local_api_server, stt, tts = await asyncio.gather(
            _init_local_api(),
            _init_stt(),
            _init_tts(),
        )
    except Exception as exc:
        logger.error(f"Startup failed: {exc}")
        # @TODO: again, clean bailout here needed
        return

    logger.opt(colors=True).info(
        "<blue>▶▶▶ Preflight complete, building services and pipeline...</blue>"
    )

    # ── Pipecat services ──────────────────────────────────────────────
    rtvi = RTVIProcessor()
    token_usage_metrics = TokenUsageMetricsProcessor(source="bot")

    # Mutable per-session state — shared with ClientMessageHandler etc.
    # Holds active voice (changes via set-voice RPC) + user-mute flag/event.
    state = BotRuntimeState(
        active_voice_name=active_voice_name,
        active_voice_language=language,
        active_tts_provider=tts_provider.value,
    )

    # System prompt. personality_tone is injected via ${personality_tone} in
    # voice_agent.md; ${universe_size} and ${fedspace_sector_count} stay as
    # placeholders here and are resolved later from the first status.snapshot.
    # language_instruction is empty for English, otherwise tells the LLM to
    # respond in the target language.
    set_prompt_substitutions(
        personality_tone=config.personality_tone or DEFAULT_PERSONALITY_TONE,
        language_instruction=(
            ""
            if language == Language.EN
            else f"IMPORTANT: Always respond in {language.name.title()}. All your spoken output must be in {language.name.title()}."
        ),
    )
    system_message = {
        "role": "system",
        "content": build_voice_agent_prompt(),
    }

    # Dedicated fast LLM for context summarization (defaults to Gemini Flash).
    summarization_llm = create_llm_service(
        LLMServiceConfig(
            provider=LLMProvider(settings.SUMMARIZATION_LLM_PROVIDER.lower()),
            model=settings.SUMMARIZATION_LLM_MODEL,
        )
    )

    auto_summarization_config = LLMAutoContextSummarizationConfig(
        max_context_tokens=None,
        max_unsummarized_messages=settings.CONTEXT_SUMMARIZATION_MESSAGE_LIMIT,
        summary_config=LLMContextSummaryConfig(
            target_context_tokens=6000,
            min_messages_after_summary=5,
            summarization_prompt=load_prompt("fragments/context_summarization.md"),
            summary_message_template="<session_history_summary>\n{summary}\n</session_history_summary>",
            llm=summarization_llm,
            summarization_timeout=120.0,
        ),
    )

    mute_strategy = TextInputBypassFirstBotMuteStrategy()

    context = LLMContext(messages=[system_message])
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            filter_incomplete_user_turns=True,
            user_turn_strategies=UserTurnStrategies(
                stop=[
                    TurnAnalyzerUserTurnStopStrategy(
                        turn_analyzer=S3SmartTurnAnalyzerV3(player_id=auth.character_id)
                    )
                ],
            ),
            user_mute_strategies=[mute_strategy],
            vad_analyzer=SileroVADAnalyzer(),
        ),
        assistant_params=LLMAssistantAggregatorParams(
            enable_auto_context_summarization=True,
            auto_context_summarization_config=auto_summarization_config,
        ),
    )

    # @TODO: Redesign say-text. Currently the old bot.py routes quest/dialog
    # speech through the main TTS pipeline, requiring a voice-swap dance
    # (TTSUpdateSettings → TTSSpeakFrame → TTSUpdateSettings restore) plus a
    # defensive SayTextVoiceGuard to catch cancelled restores. The cleaner
    # design is to sink say-text audio straight to the transport, bypassing
    # the pipeline so the LLM voice settings never get touched.

    # ── Voice context upload ──────────────────────────────────────────
    # Snapshot the LLM context to S3 on three triggers: compaction (here),
    # periodic, and shutdown. The uploader
    # manages per-session sequence numbering and the skip-if-unchanged check.
    voice_context_uploader = VoiceContextUploader(
        context=context,
        character_id=auth.character_id,
        session_id=BOT_INSTANCE_ID,
    )

    @assistant_aggregator.event_handler("on_summary_applied")
    async def on_summary_applied(aggregator, summarizer, event):
        logger.info(
            f"Context summarized: {event.original_message_count} -> "
            f"{event.new_message_count} messages "
            f"({event.summarized_message_count} compressed, "
            f"{event.preserved_message_count} preserved)"
        )
        try:
            voice_context_uploader.upload("compaction")
        except Exception as exc:
            logger.error(f"Compaction voice context upload failed: {exc}")
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

    # User mute transitions — mirror into `state` for synchronous reads and
    # async waits by consumers (ClientMessageHandler gates say-text + typed
    # input on these). Seeded muted; TextInputBypassFirstBotMuteStrategy
    # unmutes after the first bot speech completes.
    @user_aggregator.event_handler("on_user_mute_started")
    async def on_user_mute_started(aggregator):
        logger.info("User input muted")
        state.mark_user_muted()

    @user_aggregator.event_handler("on_user_mute_stopped")
    async def on_user_mute_stopped(aggregator):
        logger.info("User input unmuted")
        state.mark_user_unmuted()

    # ── Inference gates ───────────────────────────────────────────────
    # Pre/Post gates around the LLM control when inference is allowed to
    # fire — cooldown after each turn + a grace window post-LLM so trailing
    # frames don't immediately re-trigger.
    inference_gate_state = InferenceGateState(
        cooldown_seconds=2,
        post_llm_grace_seconds=1.5,
    )
    pre_llm_gate = PreLLMInferenceGate(inference_gate_state)
    post_llm_gate = PostLLMInferenceGate(inference_gate_state)

    # ── Orchestrator ───────────────────────────────────────────────────
    # Per-session owner of the game client, bus, event relay, BYOA
    # coordinator, subagent narrator, LLM context, and tool handlers.
    # Currently a stub.
    orchestrator = await Orchestrator.create(
        auth=auth,
        session_id=BOT_INSTANCE_ID or "",
        local_api_url=local_api_server.url if local_api_server else None,
        config=config,
        rtvi=rtvi,
        # llm
    )
    # orchestrator.client
    # orchestrator.bus

    # ── E2. Services that depend on the orchestrator ─────────────────────
    # Scripted agent (ScriptedAgent — on_complete references orchestrator)
    # Client message handler (ClientMessageHandler — game_client + context + voice agent)
    # Bus bridge processor (BusBridgeProcessor — orchestrator.bus)
    idle_report_processor = IdleReportProcessor(
        idle_seconds=float(settings.BOT_IDLE_REPORT_TIME),
        cooldown_seconds=float(settings.BOT_IDLE_REPORT_COOLDOWN),
        on_idle=orchestrator.on_idle_report,
        enabled=settings.BOT_IDLE_REPORT_ENABLED,
    )

    # ── F. Pipeline ──────────────────────────────────────────────────────
    # Voice agent LLM. In the eventual design the orchestrator owns this
    # (wrapped in a VoiceAgent subworker); for now we construct it inline
    # and slot it directly into the pipeline so the base flow is testable.
    voice_llm = create_llm_service(get_voice_llm_config())

    # Agent runner subscribes to the subagent bus so task/UI agents can
    # coordinate via the bus. handle_sigint follows the runner_args contract.
    try:
        await orchestrator.create_bus()
    except Exception as exc:
        logger.error(f"Subagent bus init failed: {exc}")
        return
    agent_runner = PipelineRunner(
        bus=orchestrator.bus,
        handle_sigint=getattr(runner_args, "handle_sigint", False),
    )

    # Main pipeline. Linear for now — the ParallelPipeline second branch
    # (UI agent) and idle_report_processor land once the orchestrator owns
    # game_client and voice_agent's on_idle_report callback.
    main_pipeline = Pipeline(
        [
            transport.input(),
            stt,
            idle_report_processor,
            pre_llm_gate,
            user_aggregator,
            voice_llm,
            post_llm_gate,
            token_usage_metrics,
            tts,
            transport.output(),
            assistant_aggregator,
        ]
    )
    if is_cekura_enabled():
        get_tracer().track_pipeline(main_pipeline, context, runner_args=runner_args)

    voice_agent = PipelineWorker(
        main_pipeline,
        name="main",
        params=PipelineParams(
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
        rtvi_processor=rtvi,
        rtvi_observer_params=RTVIObserverParams(
            function_call_report_level={"*": RTVIFunctionCallReportLevel.FULL},
            ignored_sources=[],  # @TODO: ui_branch_sources when UI branch lands
        ),
        cancel_on_idle_timeout=False,
        idle_timeout_secs=600,
        idle_timeout_frames=(
            BotSpeakingFrame,
            UserSpeakingFrame,
            TaskActivityFrame,
        ),
    )
    if is_cekura_enabled():
        get_tracer().register_task_handlers(voice_agent, transport=transport)

    # Hand the worker + context to the orchestrator so join() can patch
    # the system prompt and queue frames at the pipeline.
    orchestrator.attach(voice_agent=voice_agent, context=context)

    # ── Handlers ───────────────────────────────────────────────────────
    @voice_agent.event_handler("on_worker_ready")
    async def _log_worker_ready(_worker, data: WorkerReadyData) -> None:
        logger.info(f"main: {data.worker_name} ready")

    @transport.event_handler("on_client_connected")
    async def _on_client_connected(transport, client):
        logger.info("Client connected")
        # @TODO: add subworkers once they're owned by the orchestrator:
        #   await main_agent.add_worker(orchestrator.voice_agent)
        #   await main_agent.add_worker(orchestrator.scripted_agent)

    @transport.event_handler("on_client_disconnected")
    async def _on_client_disconnected(transport, client):
        logger.info("Client disconnected")
        await agent_runner.cancel()

    # on_joined only exists on the Daily transport; registering it on
    # SmallWebRTCTransport triggers a "handler not registered" warning.
    if isinstance(runner_args, DailyRunnerArguments):

        @transport.event_handler("on_joined")
        async def _on_joined(transport, data):
            await start_raw_tracks_recording(transport)

    @rtvi.event_handler("on_client_message")
    async def _on_client_message(rtvi, message):
        await orchestrator.handle_client_message(message)

    @rtvi.event_handler("on_client_ready")
    async def _on_client_ready(rtvi):
        # Fire-and-forget the join flow so the RTVI event handler returns
        # immediately.
        async def _join():
            try:
                await orchestrator.join()
                # join() appends initial messages without run_llm; fire it here.
                await voice_agent.queue_frames([LLMRunFrame()])
            except Exception as exc:
                logger.exception(f"Session initialization failed: {exc}")
                await voice_agent.cancel()

        asyncio.create_task(_join())

    await agent_runner.add_workers(voice_agent)

    # ── Periodic voice context upload ────────────────────────────────────
    # Snapshot the LLM context to S3 every 10 minutes; the uploader skips
    # if nothing changed since the last tick.
    async def _periodic_voice_context_upload():
        while True:
            await asyncio.sleep(600)
            try:
                voice_context_uploader.upload("periodic")
            except Exception as exc:
                logger.error(f"Periodic voice context upload failed: {exc}")

    periodic_upload_task: asyncio.Task | None = None

    # ── H. Run + teardown ────────────────────────────────────────────────
    try:
        periodic_upload_task = asyncio.create_task(_periodic_voice_context_upload())
        logger.info("Starting PipelineRunner…")
        await agent_runner.run()
        logger.info("PipelineRunner finished")
    except asyncio.CancelledError:
        logger.info("PipelineRunner cancelled")
        raise
    except Exception as exc:
        logger.exception(f"PipelineRunner error: {exc}")
    finally:
        if periodic_upload_task is not None:
            periodic_upload_task.cancel()
        try:
            voice_context_uploader.upload("shutdown")
        except Exception as exc:
            logger.error(f"Shutdown voice context upload failed: {exc}")
        try:
            await orchestrator.close_tasks()
        except Exception as exc:
            logger.error(f"Task cleanup failed: {exc}")
        try:
            await orchestrator.close()
        except Exception as exc:
            logger.error(f"Orchestrator close failed: {exc}")
        if local_api_server is not None:
            try:
                await local_api_server.stop()
            except Exception as exc:
                logger.error(f"Local API server stop failed: {exc}")


# ─── Runner / Entry ─────────────────────────────────────────────────────────


def _log_startup_config() -> None:
    """Pretty-print the resolved bot config at startup."""
    bus_line = settings.SUBAGENT_BUS_TRANSPORT
    if bus_line != "local":
        bus_line += "  channel=(per-session UUID)"

    divider = "─" * 103
    lines = [
        divider,
        STARTUP_BANNER.strip("\n"),
        "",
        f"  version            {__version__}",
        f"  event_transport    {settings.EVENT_TRANSPORT}",
        f"  subagent_bus       {bus_line}",
        f"  local_pooler       {'on' if settings.LOCAL_API_POSTGRES_URL else 'off (HTTP edge functions)'}",
        f"  stt                {settings.STT_PROVIDER}",
        f"  tts                {settings.TTS_PROVIDER}",
        f"  voice_llm          {settings.VOICE_LLM_PROVIDER}/{settings.VOICE_LLM_MODEL or '(provider default)'}",
        f"  task_llm           {settings.TASK_LLM_PROVIDER}/{settings.TASK_LLM_MODEL or '(provider default)'}  thinking={settings.TASK_LLM_THINKING_BUDGET}",
        f"  ui_llm             {settings.UI_AGENT_LLM_PROVIDER}/{settings.UI_AGENT_LLM_MODEL}",
        f"  summarization_llm  {settings.SUMMARIZATION_LLM_PROVIDER}/{settings.SUMMARIZATION_LLM_MODEL}",
        divider,
    ]
    logger.info("\n" + "\n".join(lines))


async def bot(runner_args: RunnerArguments):
    """Main bot entry point"""

    global BOT_INSTANCE_ID
    # Use Pipecat Cloud session_id when available, otherwise generate one.
    BOT_INSTANCE_ID = getattr(runner_args, "session_id", None) or uuid.uuid4().hex
    os.environ["BOT_INSTANCE_ID"] = BOT_INSTANCE_ID

    configure_logging(instance_id=BOT_INSTANCE_ID)

    logger.info(f"Bot session started instance_id={BOT_INSTANCE_ID}")
    logger.info(f"Bot started with runner_args: {runner_args}")

    transport_params = {
        "daily": lambda: DailyParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_filter=KrispVivaFilter() if settings.BOT_USE_KRISP else None,
        ),
        "webrtc": lambda: TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_filter=KrispVivaFilter() if settings.BOT_USE_KRISP else None,
        ),
    }

    if isinstance(runner_args, DailyRunnerArguments):
        await configure_recording_bucket(runner_args.room_url)

    transport = await create_transport(runner_args, transport_params)
    await run_bot(transport, runner_args)


if __name__ == "__main__":
    from pipecat.runner.run import main

    _log_startup_config()

    main()
