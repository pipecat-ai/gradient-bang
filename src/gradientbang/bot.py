"""
┏━╸┏━┓┏━┓╺┳┓╻┏━╸┏┓╻╺┳╸   ┏┓ ┏━┓┏┓╻┏━╸
┃╺┓┣┳┛┣━┫ ┃┃┃┣╸ ┃┗┫ ┃    ┣┻┓┣━┫┃┗┫┃╺┓
┗━┛╹┗╸╹ ╹╺┻┛╹┗━╸╹ ╹ ╹    ┗━┛╹ ╹╹ ╹┗━┛
by pipecat.ai and daily.co
"""

import asyncio
import os
import uuid
from dataclasses import dataclass

from loguru import logger
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import BotSpeakingFrame, LLMRunFrame, UserSpeakingFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_context_summarizer import (
    LLMContextSummarizer,
    SummaryAppliedEvent,
)
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
from gradientbang.config import PLAYER_AGENT_NAME, settings
from gradientbang.game.auth import Auth, AuthError
from gradientbang.game.base_client import RPCError
from gradientbang.game.local_api_server import LocalApiServer
from gradientbang.runtime.context_upload import VoiceContextUploader
from gradientbang.runtime.daily_recording import (
    configure_recording_bucket,
    start_raw_tracks_recording,
)
from gradientbang.runtime.frames import TaskActivityFrame
from gradientbang.runtime.idle_report import IdleReportProcessor
from gradientbang.runtime.inference_gate import (
    InferenceGateState,
    PostLLMInferenceGate,
    PreLLMInferenceGate,
)
from gradientbang.runtime.orchestrator import Orchestrator
from gradientbang.runtime.s3_smart_turn import S3SmartTurnAnalyzerV3
from gradientbang.runtime.user_mute import TextInputBypassFirstBotMuteStrategy
from gradientbang.runtime.voice_runtime import build_voice_tools
from gradientbang.runtime.voices import (
    DEFAULT_PERSONALITY_TONE,
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

# Tracing must initialize before @traced wrappers are created.
init_weave()
init_cekura()


@dataclass(frozen=True)
class BotRuntimeConfig:
    voice_name: str | None
    voice_id_hint: str | None
    personality_tone: str

    @classmethod
    def from_body(cls, body: dict) -> "BotRuntimeConfig":
        def _opt_str(key: str) -> str | None:
            value = body.get(key)
            if not isinstance(value, str):
                return None
            value = value.strip()
            return value or None

        return cls(
            voice_name=_opt_str("voice"),
            voice_id_hint=_opt_str("voice_id"),
            personality_tone=_opt_str("personality_tone") or "",
        )


def _log_boot_step(message: str) -> None:
    logger.opt(colors=True).info(f"<blue>▶▶▶ {message}</blue>")


# ─── Bot code ──────────────────────────────────────────────────────────


async def run_bot(transport, runner_args: RunnerArguments) -> None:
    # ── Auth ──────────────────────────────────────────────────────────
    # Authenticate before constructing session services.
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
        return

    _log_boot_step("Authentication successful, proceeding with initialization...")

    # ── Session config ─────────────────────────────────────────────────
    config = BotRuntimeConfig.from_body(body)

    tts_provider = get_tts_provider()
    voice_config = get_voice_config(config.voice_name, tts_provider) if config.voice_name else None
    if voice_config:
        voice_id = voice_config["voice_id"]
        language = Language(voice_config["language"])
    else:
        voice_id = config.voice_id_hint or get_default_voice_id(tts_provider)
        language = Language.EN

    # ── Parallel init ──────────────────────────────────────────────────
    # Run independent startup work together to keep cold starts bounded by
    # the slowest provider handshake.

    # LOCAL_API_POSTGRES_URL enables the embedded edge-function server.
    # Otherwise RPCs go through the configured Supabase URL.
    @traced
    async def _init_local_api() -> LocalApiServer | None:
        if not settings.LOCAL_API_POSTGRES_URL:
            return None
        server = LocalApiServer()
        await server.start()
        logger.info(f"Using local API server: {server.url}")
        # Warm Deno's module graph before the first game RPC.
        asyncio.create_task(server.warmup(auth.character_id))
        return server

    @traced
    async def _init_stt():
        return create_stt_service(get_stt_config(language=language))

    @traced
    async def _init_tts():
        return create_tts_service(get_tts_config(voice_id=voice_id, language=language))

    # Startup failures abort this session before the pipeline is built.
    try:
        local_api_server, stt, tts = await asyncio.gather(
            _init_local_api(),
            _init_stt(),
            _init_tts(),
        )
    except Exception as exc:
        logger.error(f"Startup failed: {exc}")
        return

    _log_boot_step("Preflight complete, building services and pipeline...")

    # ── Pipecat services ──────────────────────────────────────────────
    rtvi = RTVIProcessor()
    token_usage_metrics = TokenUsageMetricsProcessor(source="bot")

    # Session prompt substitutions known before the game bootstrap.
    # Bootstrap data patches the remaining map-size placeholders.
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

    # Separate low-latency LLM for context summarization.
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

    context = LLMContext(
        messages=[system_message],
        tools=ToolsSchema(build_voice_tools()),
    )
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

    # ── Voice context upload ──────────────────────────────────────────
    # Snapshot the LLM context on compaction, periodic ticks, and shutdown.
    voice_context_uploader = VoiceContextUploader(
        context=context,
        character_id=auth.character_id,
        session_id=BOT_INSTANCE_ID,
    )

    @assistant_aggregator.event_handler("on_summary_applied")
    async def on_summary_applied(
        aggregator,
        summarizer: LLMContextSummarizer,
        event: SummaryAppliedEvent,
    ) -> None:
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

    # ── Inference gates ───────────────────────────────────────────────
    # Prevent overlapping or immediately repeated LLM turns.
    inference_gate_state = InferenceGateState(
        cooldown_seconds=2,
        post_llm_grace_seconds=1.5,
    )
    pre_llm_gate = PreLLMInferenceGate(inference_gate_state)
    post_llm_gate = PostLLMInferenceGate(inference_gate_state)

    # ── Orchestrator ───────────────────────────────────────────────────
    # Per-session owner for game I/O, event relay, bus, and client messages.
    orchestrator = await Orchestrator.create(
        auth=auth,
        session_id=BOT_INSTANCE_ID or "",
        local_api_url=local_api_server.url if local_api_server else None,
        rtvi=rtvi,
    )

    # ── Idle Reporting ─────────────────────────────────────────────────
    idle_report_processor = IdleReportProcessor(
        idle_seconds=float(settings.BOT_IDLE_REPORT_TIME),
        cooldown_seconds=float(settings.BOT_IDLE_REPORT_COOLDOWN),
        on_idle=orchestrator.on_idle_report,
        enabled=settings.BOT_IDLE_REPORT_ENABLED,
    )

    # ── Pipeline ────────────────────────────────────────────────────────
    voice_llm = create_llm_service(get_voice_llm_config())

    # The runner owns the player worker and exposes the session bus.
    try:
        await orchestrator.create_bus()
    except Exception as exc:
        logger.error(f"Subagent bus init failed: {exc}")
        return
    agent_runner = PipelineRunner(
        bus=orchestrator.bus,
        handle_sigint=getattr(runner_args, "handle_sigint", False),
    )

    _log_boot_step("Session bus ready, building voice pipeline...")

    # The player worker runs the voice path directly:
    # input audio -> STT -> LLM -> TTS -> output audio.
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

    voice_worker = PipelineWorker(
        main_pipeline,
        name=PLAYER_AGENT_NAME,
        params=PipelineParams(
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
        rtvi_processor=rtvi,
        rtvi_observer_params=RTVIObserverParams(
            function_call_report_level={"*": RTVIFunctionCallReportLevel.FULL},
            ignored_sources=[],
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
        get_tracer().register_task_handlers(voice_worker, transport=transport)

    # The orchestrator owns glue code; the player worker owns Pipecat lifecycle
    # and bus identity.
    orchestrator.attach(
        voice_worker=voice_worker,
        voice_llm=voice_llm,
        context=context,
        transport=transport,
    )

    # ── Handlers ───────────────────────────────────────────────────────
    @transport.event_handler("on_client_connected")
    async def _on_client_connected(transport, client):
        logger.info("Client connected")

    @transport.event_handler("on_client_disconnected")
    async def _on_client_disconnected(transport, client):
        logger.info("Client disconnected")
        await agent_runner.cancel()

    # Daily-only recording hook.
    if isinstance(runner_args, DailyRunnerArguments):

        @transport.event_handler("on_joined")
        async def _on_joined(transport, data):
            await start_raw_tracks_recording(transport)

    @rtvi.event_handler("on_client_message")
    async def _on_client_message(rtvi, message):
        await orchestrator.handle_client_message(message)

    @rtvi.event_handler("on_client_ready")
    async def _on_client_ready(rtvi):
        # Keep the RTVI ready handler non-blocking.
        async def _join():
            try:
                await orchestrator.join()
                # Start the first LLM turn after bootstrap messages are queued.
                await voice_worker.queue_frames([LLMRunFrame()])
            except Exception as exc:
                if isinstance(exc, RPCError):
                    msg = f"Session initialization failed during {exc.endpoint}: {exc.status} {exc.detail}"
                    if exc.status in {401, 403}:
                        msg += " — access token may be invalid or expired"
                else:
                    msg = f"Session initialization failed: {exc}"
                logger.exception(msg)
                await voice_worker.cancel()

        asyncio.create_task(_join())

    await agent_runner.add_workers(voice_worker)
    _log_boot_step("Voice pipeline ready, starting runner...")

    # ── Periodic voice context upload ────────────────────────────────────
    # The uploader skips unchanged contexts.
    async def _periodic_voice_context_upload():
        while True:
            await asyncio.sleep(600)
            try:
                voice_context_uploader.upload("periodic")
            except Exception as exc:
                logger.error(f"Periodic voice context upload failed: {exc}")

    periodic_upload_task: asyncio.Task | None = None

    # ── Run + teardown ────────────────────────────────────────────────
    try:
        periodic_upload_task = asyncio.create_task(_periodic_voice_context_upload())
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
    """Log the process-level bot configuration."""
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
    """Create the transport and run one bot session."""

    global BOT_INSTANCE_ID
    # Prefer the platform session id for cross-service log correlation.
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
