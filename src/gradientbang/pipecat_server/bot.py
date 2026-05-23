import asyncio
import os
import uuid

# Clamp aiortc's SCTP DATA-chunk payload size so the on-wire UDP packet fits
# inside the smallest-MTU path we're likely to see in the wild (IPv6 minimum
# 1280; Tailscale overlays default to 1280; some consumer VPNs are lower).
#
# Why this is needed: aiortc/rtcsctptransport.py hardcodes USERDATA_MAX_LENGTH
# to 1200, which after SCTP (28) + DTLS (~25 with GCM auth tag) + UDP (8) +
# IPv6 (40) headers produces a ~1301-byte UDP datagram — over the 1280 MTU.
# The kernel rejects it with EMSGSIZE, SCTP retransmits at the same size, and
# the data channel silently stalls (see logs/bot.log.diag* for the bufferedAmount
# climb pattern). aiortc has no PMTU discovery (RFC 8831 §6 mandates it), so
# there is no auto-recovery. Chrome's usrsctp-based stack does PMTUD correctly,
# which is why browser↔browser WebRTC works over the same paths.
#
# 1100 leaves ~140 bytes of header slack — fits IPv4/IPv6 over DTLS/UDP on
# any path ≥ ~1240 MTU. Throughput cost is negligible: RTVI control frames
# fragment across one extra chunk at most, and audio uses RTP (separate path).
#
# Remove once aiortc ships DPLPMTUD (RFC 8899) or once we wrap this in a
# proper Pipecat-level transport option.
import aiortc.rtcsctptransport as _sctp_transport
from dotenv import load_dotenv
from loguru import logger

_SCTP_USERDATA_CLAMP = 1100
_sctp_transport.USERDATA_MAX_LENGTH = _SCTP_USERDATA_CLAMP
logger.warning(
    f"[SCTP-MTU] clamped aiortc USERDATA_MAX_LENGTH to {_SCTP_USERDATA_CLAMP} "
    "(default 1200 overshoots 1280-MTU paths like Tailscale)"
)

BOT_INSTANCE_ID: str | None = None
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import (
    Frame,
    InterruptionFrame,
    LLMFullResponseStartFrame,
    OutputTransportMessageFrame,
    OutputTransportMessageUrgentFrame,
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
from pipecat.runner.types import DailyRunnerArguments, RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.transcriptions.language import Language
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.daily.transport import DailyParams
from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.utils.context.llm_context_summarization import (
    LLMAutoContextSummarizationConfig,
    LLMContextSummaryConfig,
)

from gradientbang.pipecat_server import STARTUP_BANNER
from gradientbang.pipecat_server.s3_smart_turn import S3SmartTurnAnalyzerV3
from gradientbang.pipecat_server.session_init import gather_initial_state
from gradientbang.pipecat_server.voices import (
    DEFAULT_PERSONALITY_TONE,
    DEFAULT_VOICE,
    get_default_voice_id,
    get_voice_config,
    get_voices_for_provider,
)
from gradientbang.utils.access_token import assert_access_token_valid
from gradientbang.utils.llm_factory import (
    LLMProvider,
    LLMServiceConfig,
    create_llm_service,
    get_ui_agent_llm_config,
)
from gradientbang.utils.local_api_server import LocalApiServer
from gradientbang.utils.logging_config import configure_logging
from gradientbang.utils.prompt_loader import (
    apply_prompt_substitutions,
    build_voice_agent_prompt,
    load_prompt,
    set_prompt_substitutions,
)
from gradientbang.utils.tts_factory import create_tts_service, get_tts_config, get_tts_provider

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
from gradientbang.utils.cekura_tracing import get_tracer, init_cekura, is_cekura_enabled
from gradientbang.utils.supabase_client import AsyncGameClient, RPCError
from gradientbang.utils.token_usage_logging import TokenUsageMetricsProcessor
from gradientbang.utils.weave_tracing import init_weave, traced

if os.getenv("BOT_USE_KRISP"):
    from pipecat.audio.filters.krisp_viva_filter import KrispVivaFilter

# Initialize Weave early (before @traced decorators are applied to startup functions).
# Must come after load_dotenv so WANDB_API_KEY is available.
init_weave()

init_cekura()


async def _lookup_character_display_name(
    character_id: str, server_url: str, access_token: str | None
) -> str:
    """Return the stored display name for a character ID via API lookup.

    Args:
        character_id: Character UUID to look up
        server_url: Game server base URL
        access_token: Per-character Supabase Auth JWT (required by character_info
            under per-character auth)

    Returns:
        Character display name.

    Raises:
        RuntimeError: If the lookup fails or the server returns no name. The
            caller should let this propagate so we don't run with a broken
            display_name (e.g. the raw UUID).
    """
    try:
        async with AsyncGameClient(
            base_url=server_url,
            character_id=character_id,
            access_token=access_token,
            enable_event_polling=False,
        ) as client:
            result = await client.character_info(character_id=character_id)
    except Exception as exc:
        raise RuntimeError(f"character_info lookup failed for {character_id}: {exc}") from exc

    name = result.get("name") if isinstance(result, dict) else None
    if not name:
        raise RuntimeError(
            f"character_info returned no name for {character_id} "
            "(token may be invalid or character may not exist)"
        )
    return name


async def _resolve_character_identity(
    character_id: str | None,
    server_url: str,
    character_name_hint: str | None = None,
    access_token: str | None = None,
) -> tuple[str, str]:
    """Resolve the character UUID and display name for the voice bot.

    Args:
        character_id: Optional character ID (will use env vars if not provided)
        server_url: Game server base URL for API lookups
        character_name_hint: Optional display name from the start payload (avoids DB lookup)
        access_token: Per-character Supabase Auth JWT (used when the lookup runs)

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
    )
    if not display_name:
        # No hint or env override — must look up via the authenticated API.
        # Let exceptions propagate so we bail on auth/lookup failure rather
        # than fall through to using the raw UUID as the display_name.
        display_name = await _lookup_character_display_name(
            character_id, server_url, access_token=access_token
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
    character_id_hint: str | None,
    character_name_hint: str | None,
    server_url: str,
    access_token: str | None = None,
):
    """Resolve character identity (traced span)."""
    return await _resolve_character_identity(
        character_id_hint,
        server_url,
        character_name_hint=character_name_hint,
        access_token=access_token,
    )


@traced
async def _startup_init_stt(language: Language = Language.EN):
    """Initialize STT service (traced span)."""
    return DeepgramSTTService(
        api_key=os.getenv("DEEPGRAM_API_KEY"),
        settings=DeepgramSTTService.Settings(language=language),
    )


@traced
async def _startup_init_tts(voice_id: str, language: Language = Language.EN):
    """Initialize TTS service (traced span)."""
    return create_tts_service(get_tts_config(voice_id=voice_id, language=language))


@traced
async def bot_startup(
    character_id_hint: str | None,
    character_name_hint: str | None,
    server_url: str,
    voice_id: str,
    language: Language = Language.EN,
    access_token: str | None = None,
):
    """Traced startup wrapper — initializes all services for the bot pipeline."""

    rtvi = RTVIProcessor()

    # Chain A: local API server → resolve character (sequential)
    # Chain B: STT + TTS init (independent)

    async def _chain_a():
        local_api_server: LocalApiServer | None = None
        local_api_url: str | None = None
        if os.getenv("LOCAL_API_POSTGRES_URL"):
            local_api_server, local_api_url = await _startup_init_local_api()
            logger.info(f"Using local API server: {local_api_url}")

            # Fire-and-forget warmup so Deno JIT-compiles the shared module
            # graph before the first real game API call.
            if character_id_hint:
                asyncio.create_task(local_api_server.warmup(character_id_hint))

        character_id, character_display_name = await _startup_resolve_character(
            character_id_hint,
            character_name_hint,
            server_url,
            access_token=access_token,
        )
        return local_api_server, local_api_url, character_id, character_display_name

    (local_api_server, functions_url, character_id, character_display_name), stt, tts = await asyncio.gather(
        _chain_a(),
        _startup_init_stt(language),
        _startup_init_tts(voice_id, language),
    )

    # Create game client directly. access_token is threaded through from
    # /start (proxy injects after Supabase Auth verification, or dev sets
    # BOT_TEST_ACCESS_TOKEN) for auth-gated edge functions. Pubsub event
    # delivery uses EDGE_API_TOKEN plus SQL scope checks.
    # Event delivery is prepared by ``_join`` before bootstrap RPCs and
    # unpaused after the initial LLM context is active.
    game_client = AsyncGameClient(
        character_id=character_id,
        base_url=server_url,
        functions_url=functions_url,
        access_token=access_token,
    )

    return rtvi, local_api_server, character_id, character_display_name, game_client, stt, tts


class OutputConnectionState:
    """Tracks whether downstream transport messages should still be emitted."""

    def __init__(self) -> None:
        self.client_connected = False
        self.shutting_down = False

    @property
    def output_available(self) -> bool:
        return self.client_connected and not self.shutting_down

    def mark_client_connected(self) -> None:
        self.client_connected = True

    def mark_client_disconnected(self) -> None:
        self.client_connected = False

    def mark_shutdown(self) -> None:
        self.shutting_down = True


class DisconnectedOutputGuard(FrameProcessor):
    """Drops transport messages once the Daily signalling channel is gone."""

    _TRANSPORT_MESSAGE_TYPES = (
        OutputTransportMessageFrame,
        OutputTransportMessageUrgentFrame,
    )

    def __init__(self, state: OutputConnectionState):
        super().__init__()
        self._state = state

    async def process_frame(self, frame: Frame, direction: FrameDirection):  # type: ignore[override]
        await super().process_frame(frame, direction)

        if (
            direction == FrameDirection.DOWNSTREAM
            and not self._state.output_available
            and isinstance(frame, self._TRANSPORT_MESSAGE_TYPES)
        ):
            logger.debug("DisconnectedOutputGuard: dropped transport message after disconnect")
            return

        await self.push_frame(frame, direction)


def _join_failure_log_message(exc: Exception) -> str:
    if isinstance(exc, RPCError):
        message = f"Session initialization failed during {exc.endpoint}: {exc.status} {exc.detail}"
        if exc.status in {401, 403}:
            message += " — access token may be invalid or expired"
        return message
    return f"Session initialization failed: {exc}"


async def run_bot(transport, runner_args: RunnerArguments, **kwargs):
    """Main bot function that creates and runs the pipeline."""

    server_url = os.getenv("SUPABASE_URL")
    if not server_url:
        raise RuntimeError("SUPABASE_URL is required to run the bot.")
    logger.info(f"Using Supabase URL: {server_url}")

    body = getattr(runner_args, "body", None) or {}
    character_id_hint = body.get("character_id") or os.getenv("BOT_TEST_CHARACTER_ID")
    character_name_hint = body.get("character_name")
    # Per-character auth token — required so the bot can prove identity to
    # downstream auth-gated edge functions (e.g. character_info lookup).
    # The /start body wins; BOT_TEST_ACCESS_TOKEN is the dev
    # fallback for sessions that bypass the login → start proxy flow.
    body_access_token = body.get("access_token")
    access_token = body_access_token or os.getenv("BOT_TEST_ACCESS_TOKEN")
    # When USE_EDGE_TOKEN_FOR_AUTH=True (e.g. Cekura eval runs where the
    # per-character JWT can't be pre-minted), skip the access_token and let
    # downstream calls authenticate via X-Edge-Auth (EDGE_API_TOKEN).
    use_edge_token_for_auth = os.getenv("USE_EDGE_TOKEN_FOR_AUTH") == "True"
    if use_edge_token_for_auth:
        logger.info(
            "USE_EDGE_TOKEN_FOR_AUTH=True — authenticating via EDGE_API_TOKEN "
            "(X-Edge-Auth); per-character access_token not required."
        )
        access_token = None
    else:
        if not access_token:
            raise RuntimeError("access_token required to start a bot session.")
        logger.info(
            "access_token source: {}",
            "start payload" if body_access_token else "BOT_TEST_ACCESS_TOKEN env",
        )
        try:
            assert_access_token_valid(access_token)
        except RuntimeError as exc:
            logger.error("access_token preflight failed: {}", exc)
            raise
    # Resolve voice: prefer short name lookup for the active TTS provider,
    # then fall back to a raw provider-specific voice_id when supplied.
    tts_provider = get_tts_provider()
    voices = get_voices_for_provider(tts_provider)
    voice_name = body.get("voice")
    voice_config = get_voice_config(voice_name, tts_provider) if voice_name else None
    if voice_config:
        active_voice_name = voice_name
        voice_id = voice_config["voice_id"]
        voice_language = Language(voice_config["language"])
    else:
        active_voice_name = DEFAULT_VOICE
        voice_id = body.get("voice_id") or get_default_voice_id(tts_provider)
        voice_language = Language.EN
    personality_tone = body.get("personality_tone", "").strip()
    # ScriptedAgent / tutorial path is WIP and currently bypassed for all sessions.
    # Revisit when the scripted onboarding work resumes.
    bypass_tutorial = True

    (
        rtvi,
        local_api_server,
        character_id,
        character_display_name,
        game_client,
        stt,
        tts,
    ) = await bot_startup(
        character_id_hint,
        character_name_hint,
        server_url,
        voice_id,
        voice_language,
        access_token=access_token,
    )

    token_usage_metrics = TokenUsageMetricsProcessor(source="bot")

    # Active voice state — shared with ClientMessageHandler for runtime changes
    active_voice_state: dict = {
        "name": active_voice_name,
        "language": voice_language,
        "tts_provider": tts_provider.value,
    }

    # System prompt. Personality/tone is injected via ${personality_tone}
    # substitution in voice_agent.md; universe_size and fedspace_sector_count
    # are injected later from the first status.snapshot (see handler below).
    # language_instruction is empty for English, otherwise tells LLM to respond
    # in the target language.
    set_prompt_substitutions(
        personality_tone=personality_tone or DEFAULT_PERSONALITY_TONE,
        language_instruction=(
            ""
            if voice_language == Language.EN
            else f"IMPORTANT: Always respond in {voice_language.name.title()}. All your spoken output must be in {voice_language.name.title()}."
        ),
    )
    # System prompt still contains ${universe_size} / ${fedspace_sector_count}
    # placeholders at this point — those are resolved synchronously by
    # session_init.gather_initial_state() and patched into the context before
    # the VoiceAgent activates. Personality and language are already baked in.
    system_message = {
        "role": "system",
        "content": build_voice_agent_prompt(),
    }

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

    # Seed the shared context with the system prompt. session_init resolves
    # the ${universe_size} / ${fedspace_sector_count} placeholders inline once
    # the join RPC returns, and activation appends the initial user messages
    # behind the system message in one batch.
    context = LLMContext(messages=[system_message])
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
    output_connection_state = OutputConnectionState()

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
    disconnected_output_guard = DisconnectedOutputGuard(output_connection_state)

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
    from pipecat.pipeline.runner import PipelineRunner
    from pipecat.pipeline.worker import PipelineParams, PipelineWorker
    from pipecat.processors.frameworks.rtvi import (
        RTVIFunctionCallReportLevel,
        RTVIObserverParams,
    )
    from pipecat.registry.types import WorkerReadyData
    from pipecat.workers.llm import LLMWorkerActivationArgs

    from gradientbang.adapters.bus import make_subagent_bus
    from gradientbang.pipecat_server.frames import TaskActivityFrame
    from gradientbang.pipecat_server.idle_report import IdleReportProcessor
    from gradientbang.pipecat_server.subagents.event_relay import EventRelay
    from gradientbang.pipecat_server.subagents.scripted_agent import ScriptedAgent
    from gradientbang.pipecat_server.subagents.voice_agent import VoiceAgent

    agent_runner = PipelineRunner(
        bus=await make_subagent_bus(),
        handle_sigint=getattr(runner_args, "handle_sigint", False),
    )

    voice_agent = VoiceAgent(
        "player",
        game_client=game_client,
        character_id=character_id,
        rtvi_processor=rtvi,
    )

    event_relay = EventRelay(
        game_client=game_client,
        rtvi_processor=rtvi,
        character_id=character_id,
        task_state=voice_agent,
        bypass_tutorial=bypass_tutorial,
    )
    voice_agent._event_relay = event_relay

    async def _on_tutorial_complete():
        logger.info("Tutorial complete, switching to VoiceAgent")
        await rtvi.push_frame(
            RTVIServerMessageFrame(
                {
                    "frame_type": "event",
                    "event": "tutorial.complete",
                    "payload": {},
                }
            )
        )
        # Interrupt any in-flight scripted TTS by injecting directly into the
        # TTS service. We can't push via the main pipeline source (the
        # BusBridgeProcessor swallows upstream frames into the bus instead of
        # forwarding downstream), and we can't route via the scripted agent's
        # bus path either (the InterruptionFrame would broadcast to the voice
        # agent and cancel its activation).
        await tts.queue_frame(InterruptionFrame())
        await main_agent.deactivate_worker("scripted")
        # Reset mute strategy so the normal first-bot-speech logic applies fresh.
        # Release force_mute AFTER deactivating scripted agent to avoid any
        # in-flight BotStoppedSpeakingFrame from the tutorial triggering unmute.
        await mute_strategy.reset()
        mute_strategy.force_mute = False
        # Tutorial re-enable needs initial_state threaded into this callback.
        await main_agent.activate_worker("player")

    scripted_agent = ScriptedAgent(
        "scripted",
        rtvi_processor=rtvi,
        on_complete=_on_tutorial_complete,
    )

    idle_report_processor = IdleReportProcessor(
        idle_seconds=float(os.getenv("BOT_IDLE_REPORT_TIME", "9")),
        cooldown_seconds=float(os.getenv("BOT_IDLE_REPORT_COOLDOWN", "45")),
        on_idle=voice_agent.on_idle_report,
        enabled=os.getenv("BOT_IDLE_REPORT_ENABLED", "1") not in ("0", "false", ""),
    )

    # The transport worker hosts the voice pipeline directly — no subclass.
    # Voice LLM lives inline in branch 0 (no bus hop); VoiceAgent keeps a
    # no-op pipeline so its bus-subscription / activation / job-supervision
    # lifecycle still works.
    main_pipeline = Pipeline(
        [
            transport.input(),
            stt,
            idle_report_processor,
            pre_llm_gate,
            user_aggregator,
            ParallelPipeline(
                [
                    voice_agent._llm,
                    post_llm_gate,
                    token_usage_metrics,
                    say_text_voice_guard,
                    tts,
                    disconnected_output_guard,
                    transport.output(),
                    assistant_aggregator,
                ],
                ui_branch,
            ),
        ]
    )
    if is_cekura_enabled():
        get_tracer().track_pipeline(main_pipeline, context, runner_args=runner_args)
    main_agent = PipelineWorker(
        main_pipeline,
        name="main",
        params=PipelineParams(
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
        rtvi_processor=rtvi,
        rtvi_observer_params=RTVIObserverParams(
            function_call_report_level={
                "*": RTVIFunctionCallReportLevel.FULL,
            },
            ignored_sources=list(ui_branch_sources),
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
        get_tracer().register_task_handlers(main_agent, transport=transport)

    @main_agent.event_handler("on_worker_ready")
    async def _log_worker_ready(_worker, data: WorkerReadyData) -> None:
        logger.info(f"main: {data.worker_name} ready")

    @transport.event_handler("on_client_connected")
    async def _on_client_connected(transport, client):
        output_connection_state.mark_client_connected()
        logger.info("Client connected, adding subworkers")
        await main_agent.add_worker(voice_agent)
        await main_agent.add_worker(scripted_agent)

    # Main pipeline IS the worker now — route VoiceAgent through it.
    voice_agent.attach_main_pipeline_task(main_agent)
    voice_agent.install_main_pipeline_lifecycle_watchers(main_agent)

    await agent_runner.add_workers(main_agent)

    # ── Event handlers ─────────────────────────────────────────────────

    is_first_visit = False

    @rtvi.event_handler("on_client_ready")
    async def on_client_ready(rtvi):
        nonlocal is_first_visit

        async def _join():
            nonlocal is_first_visit
            try:
                await asyncio.sleep(2)
                # Register the session queue before bootstrap RPCs, then
                # discard only matching startup echoes before activation.
                await game_client.prepare_event_delivery_for_bootstrap()

                initial_state = await gather_initial_state(
                    game_client=game_client,
                    character_id=character_id,
                    character_display_name=character_display_name,
                    bypass_tutorial=bypass_tutorial,
                )
                is_first_visit = initial_state.is_first_visit

                subs: dict[str, str | int] = {}
                if initial_state.universe_size is not None:
                    subs["universe_size"] = initial_state.universe_size
                if initial_state.fedspace_sector_count is not None:
                    subs["fedspace_sector_count"] = initial_state.fedspace_sector_count
                if subs:
                    set_prompt_substitutions(**subs)
                    for msg in context.messages:
                        if msg.get("role") == "system":
                            msg["content"] = apply_prompt_substitutions(msg["content"])
                            break

                await event_relay.attach_session_state(
                    session_started_at=initial_state.session_started_at,
                    display_name=initial_state.display_name,
                    is_new_player=initial_state.is_new_player,
                )

                # Hydrate the web client with the same bootstrap data used for
                # the initial LLM context.
                async def _emit_client_event(event_name: str, payload: dict) -> None:
                    await rtvi.push_frame(
                        RTVIServerMessageFrame(
                            {
                                "frame_type": "event",
                                "event": event_name,
                                "payload": payload,
                            }
                        )
                    )

                # Client map handlers require the bound player id.
                map_local_payload = {
                    **initial_state.map_local_payload,
                    "player": {"id": character_id},
                }

                await _emit_client_event("status.snapshot", initial_state.status_payload)
                await _emit_client_event("map.local", map_local_payload)
                await _emit_client_event(
                    "ships.list",
                    {"ships": initial_state.ships_payload.get("ships", [])},
                )
                await _emit_client_event(
                    "quest.status",
                    {"quests": initial_state.quest_payload.get("quests", [])},
                )

                # Keep non-bootstrap events that arrived during startup.
                await game_client.complete_event_delivery_bootstrap()

                if is_first_visit and not bypass_tutorial:
                    logger.info("First visit detected, activating ScriptedAgent")
                    mute_strategy.force_mute = True
                    await main_agent.activate_worker("scripted")
                else:
                    if is_first_visit and bypass_tutorial:
                        logger.info(
                            "First visit detected but bypass_tutorial=True; skipping ScriptedAgent"
                        )
                    await main_agent.activate_worker(
                        "player",
                        args=LLMWorkerActivationArgs(
                            messages=initial_state.initial_messages,
                            run_llm=True,
                        ),
                    )

                await game_client.replay_event_delivery_catchup()
                await game_client.start_event_delivery()
            except Exception as exc:
                # Fire-and-forget task would swallow this otherwise. Tear down
                # the runner so the session exits instead of hanging half-joined.
                output_connection_state.mark_shutdown()
                logger.exception("{}", _join_failure_log_message(exc))
                await main_agent.cancel()

        asyncio.create_task(_join())

    client_message_handler = ClientMessageHandler(
        game_client=game_client,
        character_id=character_id,
        rtvi=rtvi,
        transport=transport,
        main_agent=main_agent,
        tts=tts,
        stt=stt,
        say_text_restore_voice=say_text_restore_voice,
        user_mute_state=user_mute_state,
        user_unmuted_event=user_unmuted_event,
        llm_context=context,
        voice_agent=voice_agent,
        on_skip_tutorial=_on_tutorial_complete,
        active_voice_state=active_voice_state,
        voices=voices,
    )

    @rtvi.event_handler("on_client_message")
    async def on_client_message(rtvi, message):
        await client_message_handler.handle(message)

    @transport.event_handler("on_joined")
    async def on_joined(transport, data):
        if not hasattr(transport, "start_recording"):
            return
        if not os.getenv("DAILY_RECORDING_BUCKET_NAME"):
            return
        logger.info("Starting raw-tracks recording")
        try:
            settings = {"layout": {"preset": "audio-only"}}
            stream_id, error = await transport.start_recording(settings, None, False)
            if error:
                logger.error(f"Failed to start recording: {error}")
            else:
                logger.info(f"Recording started (stream_id={stream_id})")
        except Exception as exc:
            logger.error(f"Failed to start recording: {exc}")

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        output_connection_state.mark_client_disconnected()
        logger.info("Client disconnected")
        await agent_runner.cancel()

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
        logger.info("Starting PipelineRunner…")
        await agent_runner.run()
        logger.info("PipelineRunner finished")
    except asyncio.CancelledError:
        logger.info("PipelineRunner cancelled")
        raise
    except Exception as e:
        logger.exception(f"PipelineRunner error: {e}")
    finally:
        output_connection_state.mark_shutdown()
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


async def _configure_recording_bucket(room_url: str):
    bucket = os.getenv("DAILY_RECORDING_BUCKET_NAME")
    region = os.getenv("DAILY_RECORDING_BUCKET_REGION")
    role_arn = os.getenv("DAILY_RECORDING_ASSUME_ROLE_ARN")
    api_key = os.getenv("DAILY_API_KEY")

    if not all([bucket, region, role_arn]):
        logger.debug("Recording bucket env vars not set, skipping room config")
        return

    if not api_key:
        logger.warning("DAILY_API_KEY not set, cannot configure recording bucket")
        return

    from urllib.parse import urlparse

    import aiohttp

    room_name = urlparse(room_url).path.lstrip("/")
    url = f"https://api.daily.co/v1/rooms/{room_name}"
    headers = {"Authorization": f"Bearer {api_key}"}
    body = {
        "properties": {
            "enable_recording": "raw-tracks",
            "enable_raw_tracks_event_json": True,
            "enable_raw_tracks_transcoded_audio": "aac",
            "recordings_bucket": {
                "bucket_name": bucket,
                "bucket_region": region,
                "assume_role_arn": role_arn,
                "allow_api_access": False,
            },
        }
    }

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, headers=headers, json=body) as resp:
                if resp.status == 200:
                    logger.info(f"Configured recording bucket on room {room_name}")
                else:
                    text = await resp.text()
                    logger.error(
                        f"Failed to configure recording bucket (status {resp.status}): {text}"
                    )
    except Exception as exc:
        logger.error(f"Failed to configure recording bucket: {exc}")


def _log_startup_config() -> None:
    """Pretty-print the core bot config so transport choices are obvious at a glance.

    Called once per process at module import (before the HTTP server starts
    listening), not per-session — the config is fixed for the lifetime of
    the process. Reads env directly to avoid the LLM-factory side effects
    (warnings on unknown providers, etc.).
    """
    from gradientbang import __version__

    bus_transport = os.getenv("SUBAGENT_BUS_TRANSPORT", "local").strip().lower()
    event_transport = os.getenv("EVENT_TRANSPORT", "pubsub").strip().lower()
    stt_provider = "deepgram"
    tts_provider = os.getenv("TTS_PROVIDER", "gradium").strip().lower()
    voice_provider = os.getenv("VOICE_LLM_PROVIDER", "google").strip().lower()
    voice_model = os.getenv("VOICE_LLM_MODEL", "(provider default)").strip()
    task_provider = os.getenv("TASK_LLM_PROVIDER", "google").strip().lower()
    task_model = os.getenv("TASK_LLM_MODEL", "(provider default)").strip()
    task_thinking = os.getenv("TASK_LLM_THINKING_BUDGET", "4096").strip()
    ui_provider = os.getenv("UI_AGENT_LLM_PROVIDER", "google").strip().lower()
    ui_model = os.getenv("UI_AGENT_LLM_MODEL", "gemini-2.5-flash").strip()
    local_pooler = bool(os.getenv("LOCAL_API_POSTGRES_URL", "").strip())

    bus_line = f"{bus_transport}"
    if bus_transport != "local":
        bus_line += "  channel=(per-session UUID)"

    divider = "─" * 103
    lines = [
        divider,
        STARTUP_BANNER.strip("\n"),
        "",
        f"  version            {__version__}",
        f"  event_transport    {event_transport}",
        f"  subagent_bus       {bus_line}",
        f"  local_pooler       {'on' if local_pooler else 'off (HTTP edge functions)'}",
        f"  stt                {stt_provider}",
        f"  tts                {tts_provider}",
        f"  voice_llm          {voice_provider}/{voice_model}",
        f"  task_llm           {task_provider}/{task_model}  thinking={task_thinking}",
        f"  ui_llm             {ui_provider}/{ui_model}",
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
            audio_in_filter=(KrispVivaFilter() if os.getenv("BOT_USE_KRISP") else None),
        ),
        "webrtc": lambda: TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_filter=(KrispVivaFilter() if os.getenv("BOT_USE_KRISP") else None),
        ),
    }

    if isinstance(runner_args, DailyRunnerArguments):
        await _configure_recording_bucket(runner_args.room_url)

    transport = await create_transport(runner_args, transport_params)
    await run_bot(transport, runner_args)


if __name__ == "__main__":
    from pipecat.runner.run import main

    _log_startup_config()
    main()
