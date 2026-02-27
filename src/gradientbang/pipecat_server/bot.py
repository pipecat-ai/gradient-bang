import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv
from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import (
    BotSpeakingFrame,
    EndFrame,
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMMessagesAppendFrame,
    LLMRunFrame,
    LLMTextFrame,
    StartFrame,
    StopFrame,
    TranscriptionFrame,
    TTSSpeakFrame,
    TTSUpdateSettingsFrame,
    UserSpeakingFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.pipeline.parallel_pipeline import ParallelPipeline
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.processors.frameworks.rtvi import (
    RTVIObserver,
    RTVIProcessor,
    RTVIServerMessageFrame,
)
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.services.cartesia.tts import CartesiaTTSService
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.daily.transport import DailyParams
from pipecat.utils.time import time_now_iso8601

from gradientbang.utils.llm_factory import (
    create_llm_service,
    get_ui_agent_llm_config,
    get_voice_llm_config,
)
from gradientbang.utils.local_api_server import LocalApiServer
from gradientbang.utils.prompt_loader import build_voice_agent_prompt

load_dotenv(dotenv_path=".env.bot")

from gradientbang.pipecat_server.chat_history import emit_chat_history, fetch_chat_history
from gradientbang.pipecat_server.context_compression import (
    ContextCompressionConsumer,
    ContextCompressionProducer,
)
from gradientbang.pipecat_server.frames import TaskActivityFrame, UserTextInputFrame
from gradientbang.pipecat_server.inference_gate import (
    InferenceGateState,
    PostLLMInferenceGate,
    PreLLMInferenceGate,
)
from gradientbang.pipecat_server.ui_agent import (
    UIAgentContext,
    UIAgentResponseCollector,
)
from gradientbang.pipecat_server.user_mute import TextInputBypassFirstBotMuteStrategy
from gradientbang.pipecat_server.voice_task_manager import VoiceTaskManager
from gradientbang.utils.supabase_client import AsyncGameClient
from gradientbang.utils.token_usage_logging import TokenUsageMetricsProcessor

if os.getenv("BOT_USE_KRISP"):
    from pipecat.audio.filters.krisp_viva_filter import KrispVivaFilter

# Configure loguru
logger.remove()
logger.add(sys.stderr, level="INFO")


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


async def _resolve_character_identity(character_id: str | None, server_url: str) -> tuple[str, str]:
    """Resolve the character UUID and display name for the voice bot.

    Args:
        character_id: Optional character ID (will use env vars if not provided)
        server_url: Game server base URL for API lookups

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
        os.getenv("BOT_TEST_CHARACTER_NAME")
        or os.getenv("BOT_TEST_NPC_CHARACTER_NAME")
        or await _lookup_character_display_name(character_id, server_url)
        or character_id
    )
    return character_id, display_name


def create_chat_system_prompt() -> str:
    """Create the system prompt for the chat agent."""
    return build_voice_agent_prompt()


async def run_bot(transport, runner_args: RunnerArguments, **kwargs):
    """Main bot function that creates and runs the pipeline."""

    # Create RTVI processor
    rtvi = RTVIProcessor()

    server_url = os.getenv("SUPABASE_URL")
    if not server_url:
        raise RuntimeError("SUPABASE_URL is required to run the bot.")
    logger.info(f"Using Supabase URL: {server_url}")

    # Start local API server if LOCAL_API_POSTGRES_URL is set
    local_api_server: LocalApiServer | None = None
    if os.getenv("LOCAL_API_POSTGRES_URL"):
        local_api_server = LocalApiServer()
        local_api_url = await local_api_server.start()
        os.environ["EDGE_FUNCTIONS_URL"] = local_api_url
        logger.info(f"Using local API server: {local_api_url}")

    character_id, character_display_name = await _resolve_character_identity(
        (getattr(runner_args, "body", None) or {}).get("character_id", None)
        or os.getenv("BOT_TEST_CHARACTER_ID"),
        server_url,
    )
    logger.info(
        f"Initializing VoiceTaskManager with character_id={character_id} display_name={character_display_name}"
    )

    # Create voice task manager
    task_manager = VoiceTaskManager(
        character_id=character_id,
        rtvi_processor=rtvi,
        base_url=server_url,
    )

    # Initialize STT service
    logger.info("Init STT…")
    stt = DeepgramSTTService(
        api_key=os.getenv("DEEPGRAM_API_KEY"),
    )

    # Initialize TTS service (managed session)
    logger.info("Init TTS (Cartesia)…")
    cartesia_key = os.getenv("CARTESIA_API_KEY", "")
    if not cartesia_key:
        logger.warning("CARTESIA_API_KEY is not set; TTS may fail.")
    tts = CartesiaTTSService(api_key=cartesia_key, voice_id="ec1e269e-9ca0-402f-8a18-58e0e022355a")

    # Initialize LLM service
    logger.info("Init LLM…")
    voice_config = get_voice_llm_config()
    llm = create_llm_service(voice_config)
    llm.register_function(None, task_manager.execute_tool_call)

    @llm.event_handler("on_function_calls_started")
    async def on_function_calls_started(service, function_calls):
        for call in function_calls:
            await rtvi.push_frame(
                RTVIServerMessageFrame(
                    {
                        "frame_type": "event",
                        "event": "llm.function_call",
                        "payload": {"name": call.function_name},
                    }
                )
            )

    token_usage_metrics = TokenUsageMetricsProcessor(source="bot")

    # System prompt
    messages = [
        {
            "role": "system",
            "content": create_chat_system_prompt(),
        },
        {
            "role": "user",
            "content": f"<start_of_session>Character Name: {character_display_name}</start_of_session>",
        },
    ]

    # Create context aggregator
    context = LLMContext(messages, tools=task_manager.get_tools_schema())
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            filter_incomplete_user_turns=True,
            user_mute_strategies=[
                TextInputBypassFirstBotMuteStrategy(),
            ],
            vad_analyzer=SileroVADAnalyzer(),
        ),
    )
    # Pipecat 0.0.102 emits UserMuteStartedFrame when mute state flips.
    # In our parallel pipeline this can happen before StartFrame reaches branch
    # sources, triggering startup errors. Seed initial mute state to avoid an
    # early transition/frame emission before startup completes.
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
        cooldown_seconds=2.0,
        post_llm_grace_seconds=1.5,
    )
    pre_llm_gate = PreLLMInferenceGate(inference_gate_state)
    post_llm_gate = PostLLMInferenceGate(inference_gate_state)

    # Create compression producer and consumer for context management
    google_api_key = os.getenv("GOOGLE_API_KEY")
    compression_producer = ContextCompressionProducer(
        api_key=google_api_key,
        message_threshold=200,
    )
    compression_consumer = ContextCompressionConsumer(producer=compression_producer)

    # Create UI agent branch components (3-processor design)
    ui_agent_config = get_ui_agent_llm_config()
    ui_agent_context = UIAgentContext(
        config=ui_agent_config,
        rtvi=rtvi,
        game_client=task_manager.game_client,
    )
    ui_llm = create_llm_service(ui_agent_config)
    ui_llm.register_function("control_ui", ui_agent_context.handle_control_ui)
    ui_llm.register_function("queue_ui_intent", ui_agent_context.handle_queue_ui_intent)
    ui_llm.register_function("corporation_info", ui_agent_context.handle_corporation_info)
    ui_llm.register_function("my_status", ui_agent_context.handle_my_status)
    ui_response_collector = UIAgentResponseCollector(context=ui_agent_context)

    ui_branch: list[FrameProcessor] = [ui_agent_context, ui_llm, ui_response_collector]
    ui_branch_sources = set(ui_branch)

    # Create pipeline with parallel compression + UI branches
    output_transport = transport.output()

    logger.info("Create pipeline…")
    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            pre_llm_gate,
            user_aggregator,
            ParallelPipeline(
                # Main branch
                [
                    llm,
                    post_llm_gate,
                    token_usage_metrics,
                    say_text_voice_guard,
                    tts,
                    assistant_aggregator,
                    output_transport,
                    compression_consumer,  # Receives compression results
                ],
                # Compression monitoring branch (sink)
                [compression_producer],
                # UI agent branch
                ui_branch,
            ),
        ]
    )

    # Configure idle_timeout_frames to include TaskActivityFrame so long-running tasks
    # don't cause the pipeline to timeout when there's no voice interaction
    logger.info("Create task…")
    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
        rtvi_processor=rtvi,
        cancel_on_idle_timeout=False,
        idle_timeout_secs=600,
        idle_timeout_frames=(BotSpeakingFrame, UserSpeakingFrame, TaskActivityFrame),
    )

    runner: PipelineRunner | None = None
    shutdown_lock = asyncio.Lock()
    shutdown_started = False

    @task.event_handler("on_idle_timeout")
    async def on_idle_timeout(task):
        logger.info("Pipeline has been idle for too long")
        messages = [
            {
                "role": "system",
                "content": "The player has been inactive. Say a quick goodbye — you're disconnecting due to inactivity.",
            }
        ]
        await task.queue_frames([LLMMessagesAppendFrame(messages, run_llm=True)])
        await task.queue_frame(EndFrame())

    async def _shutdown(reason: str) -> None:
        nonlocal shutdown_started
        async with shutdown_lock:
            if shutdown_started:
                return
            shutdown_started = True

        logger.info(f"Shutting down bot pipeline ({reason})")
        try:
            await task.cancel(reason=reason)
        except Exception as exc:
            logger.debug(f"Task cancel during shutdown raised: {exc}")

        if runner is not None:
            try:
                await runner.cancel()
            except Exception as exc:
                logger.debug(f"Runner cancel during shutdown raised: {exc}")

        try:
            await task_manager.close()
        except Exception as exc:
            logger.error(f"Task manager close during shutdown failed: {exc}")

        if local_api_server is not None:
            try:
                await local_api_server.stop()
            except Exception as exc:
                logger.error(f"Local API server stop failed: {exc}")

    # Patch RTVI observer to ignore LLM frames from UI branch sources.
    # This prevents UI agent inference from leaking bot-llm-text, user-llm-text,
    # bot-llm-started, bot-llm-stopped RTVI messages to the client.
    # Note: Uses a closure (not default kwargs) so inspect.signature sees exactly
    # 1 parameter — matching the expected on_push_frame(data) convention that
    # TaskObserver._proxy_task_handler checks.
    _LLM_FRAME_TYPES = (
        LLMTextFrame,
        LLMContextFrame,
        LLMFullResponseStartFrame,
        LLMFullResponseEndFrame,
    )
    for obs in task._observer._observers:
        if isinstance(obs, RTVIObserver):
            _orig_rtvi_on_push = obs.on_push_frame

            async def _filtered_rtvi_on_push(data):
                if data.source in ui_branch_sources and isinstance(data.frame, _LLM_FRAME_TYPES):
                    return
                await _orig_rtvi_on_push(data)

            obs.on_push_frame = _filtered_rtvi_on_push
            logger.info("Installed source-based LLM frame filter on RTVI observer")
            break

    @task.rtvi.event_handler("on_client_ready")
    async def on_client_ready(rtvi):
        async def _join():
            await asyncio.sleep(2)
            await task_manager.game_client.pause_event_delivery()
            await task_manager.join()
            await task_manager.game_client.resume_event_delivery()

        asyncio.create_task(_join())

    @task.rtvi.event_handler("on_client_message")
    async def on_client_message(rtvi, message):
        """Handle custom messages from the client."""
        logger.info(f"Received client message: {message}")

        # Extract message type and data from RTVIClientMessage object
        msg_type = message.type
        msg_data = message.data if hasattr(message, "data") else {}

        # Start (for web client)
        if msg_type == "start":
            logger.info("Received start message, running pipeline")
            await task.queue_frames([LLMRunFrame()])
            return

        # Mute / unmute control
        if msg_type == "mute-unmute":
            try:
                mute = bool((msg_data or {}).get("mute"))
            except Exception:
                mute = False
            # Prefer transport-native mute to avoid tearing down the pipeline
            try:
                transport.set_input_muted(mute)
                logger.info(f"Microphone {'muted' if mute else 'unmuted'} (transport flag)")
            except Exception:
                # Fallback to control frames
                if mute:
                    await transport.input().push_frame(StopFrame())
                    logger.info("Microphone muted (StopFrame fallback)")
                else:
                    await transport.input().push_frame(StartFrame())
                    logger.info("Microphone unmuted (StartFrame fallback)")
            return

        # Client requested my status
        if msg_type == "get-my-status":
            # Trigger a status.snapshot event from the task manager
            await task_manager.game_client.my_status(task_manager.character_id)
            return

        # Client requested known ports
        if msg_type == "get-known-ports":
            # Call list_known_ports to trigger server-side ports.list event
            # The client will receive the port data via the ports.list event
            await task_manager.game_client.list_known_ports(task_manager.character_id)
            return

        # Client requested task history
        if msg_type == "get-task-history":
            try:
                # Get optional ship_id and max_rows from message data
                ship_id = msg_data.get("ship_id") if isinstance(msg_data, dict) else None
                max_rows_raw = msg_data.get("max_rows") if isinstance(msg_data, dict) else None
                max_rows = int(max_rows_raw) if max_rows_raw is not None else 50

                end_time = datetime.now(timezone.utc)
                start_time = end_time - timedelta(days=30)  # Last 30 days

                target_character = ship_id or task_manager.character_id

                # Query task.start and task.finish events in parallel
                # (API doesn't support OR filters, so we run both concurrently)
                start_query = task_manager.game_client.event_query(
                    start=start_time.isoformat(),
                    end=end_time.isoformat(),
                    character_id=target_character,
                    filter_event_type="task.start",
                    max_rows=max_rows + 10,
                    sort_direction="reverse",
                )
                finish_query = task_manager.game_client.event_query(
                    start=start_time.isoformat(),
                    end=end_time.isoformat(),
                    character_id=target_character,
                    filter_event_type="task.finish",
                    max_rows=max_rows + 10,
                    sort_direction="reverse",
                )
                start_result, finish_result = await asyncio.gather(start_query, finish_query)

                start_events = start_result.get("events", [])
                finish_events = finish_result.get("events", [])

                # Build map of finish events by task_id
                finish_by_task_id: dict = {}
                for event in finish_events:
                    task_id = event.get("task_id")
                    if task_id:
                        finish_by_task_id[task_id] = event

                # Build task history entries from start events
                tasks = []
                for start_event in start_events:
                    task_id = start_event.get("task_id")
                    if not task_id:
                        continue
                    finish_event = finish_by_task_id.get(task_id)
                    start_payload = start_event.get("payload", {})
                    finish_payload = finish_event.get("payload", {}) if finish_event else {}
                    end_summary = None
                    end_status = None
                    if finish_event:
                        end_summary = (
                            finish_payload.get("task_summary")
                            or finish_payload.get("summary")
                            or finish_payload.get("result")
                        )
                        end_status = finish_payload.get("task_status")
                    tasks.append(
                        {
                            "task_id": task_id,
                            "started": start_event.get("timestamp"),
                            "ended": finish_event.get("timestamp") if finish_event else None,
                            "start_instructions": start_payload.get("task_description")
                            or start_payload.get("instructions")
                            or "",
                            "end_summary": end_summary,
                            "end_status": end_status,
                            "actor_character_id": start_payload.get("actor_character_id"),
                            "actor_character_name": start_payload.get("actor_character_name"),
                            "task_scope": start_payload.get("task_scope"),
                            "ship_id": start_payload.get("ship_id"),
                            "ship_name": start_payload.get("ship_name"),
                            "ship_type": start_payload.get("ship_type"),
                        }
                    )

                # Sort by start time descending and limit
                tasks.sort(key=lambda t: t["started"] or "", reverse=True)
                tasks = tasks[:max_rows]

                # Emit task.history event directly to client
                await rtvi.push_frame(
                    RTVIServerMessageFrame(
                        {
                            "frame_type": "event",
                            "event": "task.history",
                            "payload": {
                                "tasks": tasks,
                                "total_count": len(tasks),
                            },
                        }
                    )
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception("Failed to fetch task history")
                await rtvi.push_frame(
                    RTVIServerMessageFrame({"frame_type": "error", "error": str(exc)})
                )
            return

        # Client requested task events
        if msg_type == "get-task-events":
            try:
                if not isinstance(msg_data, dict) or not msg_data.get("task_id"):
                    raise ValueError("get-task-events requires task_id in message data")
                task_id = msg_data.get("task_id")

                # Pagination params
                cursor_raw = msg_data.get("cursor")
                cursor = int(cursor_raw) if cursor_raw is not None else None
                max_rows_raw = msg_data.get("max_rows")
                max_rows = int(max_rows_raw) if max_rows_raw is not None else None

                # Use event_query with filter_task_id filter - last 24 hours by default
                end_time = datetime.now(timezone.utc)
                start_time = end_time - timedelta(hours=24)
                result = await task_manager.game_client.event_query(
                    start=start_time.isoformat(),
                    end=end_time.isoformat(),
                    filter_task_id=task_id,
                    character_id=task_manager.character_id,
                    cursor=cursor,
                    max_rows=max_rows,
                )
                # Emit event.query result directly to client
                await rtvi.push_frame(
                    RTVIServerMessageFrame(
                        {
                            "frame_type": "event",
                            "event": "event.query",
                            "payload": result,
                        }
                    )
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception("Failed to fetch task events")
                await rtvi.push_frame(
                    RTVIServerMessageFrame({"frame_type": "error", "error": str(exc)})
                )
            return

        # Client requested chat history
        if msg_type == "get-chat-history":
            try:
                since_hours_raw = (
                    msg_data.get("since_hours") if isinstance(msg_data, dict) else None
                )
                since_hours = int(since_hours_raw) if since_hours_raw is not None else 24
                max_rows_raw = msg_data.get("max_rows") if isinstance(msg_data, dict) else None
                max_rows = int(max_rows_raw) if max_rows_raw is not None else 50

                messages = await fetch_chat_history(
                    task_manager.game_client,
                    task_manager.character_id,
                    since_hours=since_hours,
                    max_rows=max_rows,
                )
                await emit_chat_history(rtvi, messages)
            except Exception as exc:  # noqa: BLE001
                logger.exception("Failed to fetch chat history")
                await rtvi.push_frame(
                    RTVIServerMessageFrame({"frame_type": "error", "error": str(exc)})
                )
            return

        # Client requested task cancellation
        if msg_type == "cancel-task":
            try:
                if not isinstance(msg_data, dict) or not msg_data.get("task_id"):
                    raise ValueError("cancel-task requires task_id in message data")
                task_id = msg_data.get("task_id")

                await task_manager.game_client.task_cancel(
                    task_id=task_id,
                    character_id=task_manager.character_id,
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception("Failed to cancel task via client message")
                await rtvi.push_frame(
                    RTVIServerMessageFrame({"frame_type": "error", "error": str(exc)})
                )
            return

        # Client requested ships list
        if msg_type == "get-my-ships":
            try:
                await task_manager.game_client.list_user_ships(
                    character_id=task_manager.character_id,
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception("Failed to fetch user ships")
                await rtvi.push_frame(
                    RTVIServerMessageFrame({"frame_type": "error", "error": str(exc)})
                )
            return

        # Client requested ship definitions
        if msg_type == "get-ship-definitions":
            try:
                await task_manager.game_client.get_ship_definitions()
            except Exception as exc:  # noqa: BLE001
                logger.exception("Failed to fetch ship definitions")
                await rtvi.push_frame(
                    RTVIServerMessageFrame({"frame_type": "error", "error": str(exc)})
                )
            return

        # Client requested corporation data
        if msg_type == "get-my-corporation":
            try:
                await task_manager.game_client._request(
                    "my_corporation",
                    {"character_id": task_manager.character_id},
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception("Failed to fetch corporation data")
                await rtvi.push_frame(
                    RTVIServerMessageFrame({"frame_type": "error", "error": str(exc)})
                )
            return

        if msg_type == "get-my-map":
            try:
                if not isinstance(msg_data, dict):
                    raise ValueError("Message data must be an object")

                fit_sectors = msg_data.get("fit_sectors")
                if fit_sectors is not None:
                    if not isinstance(fit_sectors, list):
                        raise ValueError("fit_sectors must be a list of sector IDs")
                    fit_sectors = [
                        int(sector)
                        for sector in fit_sectors
                        if isinstance(sector, (int, float, str)) and str(sector).strip() != ""
                    ]
                    if not fit_sectors:
                        raise ValueError("fit_sectors must include at least one sector")
                else:
                    center_sector = msg_data.get("center_sector")
                    if center_sector is None:
                        raise ValueError("Missing required field 'center_sector'")
                    center_sector = int(center_sector)

                bounds_raw = msg_data.get("bounds")
                max_sectors_raw = msg_data.get("max_sectors")
                max_hops_raw = msg_data.get("max_hops")

                bounds = int(bounds_raw) if bounds_raw is not None else None
                if bounds is not None and (bounds < 0 or bounds > 100):
                    raise ValueError("bounds must be between 0 and 100")

                max_hops = (
                    int(max_hops_raw)
                    if max_hops_raw is not None
                    else None
                    if bounds is not None
                    else 3
                )
                if max_hops is not None and (max_hops < 0 or max_hops > 100):
                    raise ValueError("max_hops must be between 0 and 100")

                max_sectors = (
                    int(max_sectors_raw)
                    if max_sectors_raw is not None
                    else None
                    if bounds is not None
                    else 1000
                )
                if max_sectors is not None and max_sectors <= 0:
                    raise ValueError("max_sectors must be positive")

                # Use local_map_region endpoint
                await task_manager.game_client.local_map_region(
                    character_id=task_manager.character_id,
                    center_sector=center_sector if fit_sectors is None else None,
                    bounds=bounds,
                    max_hops=max_hops,
                    max_sectors=max_sectors,
                    fit_sectors=fit_sectors,
                    source="get-my-map",
                )

            except Exception as exc:  # noqa: BLE001
                logger.exception("Failed to fetch local map region via client message")
                await rtvi.push_frame(
                    RTVIServerMessageFrame({"frame_type": "error", "error": str(exc)})
                )
            return

        if msg_type == "salvage_collect":
            await task_manager.game_client.salvage_collect(
                character_id=task_manager.character_id,
                salvage_id=msg_data.get("salvage_id"),
            )
            return

        if msg_type == "combat-action":
            await task_manager.game_client.combat_action(
                character_id=task_manager.character_id,
                combat_id=msg_data.get("combat_id"),
                action=msg_data.get("action"),
                commit=msg_data.get("commit"),
                round_number=msg_data.get("round"),
                target_id=msg_data.get("target_id"),
                to_sector=msg_data.get("to_sector"),
            )
            return

        # Handle say-text: generate TTS with an optional temporary voice
        if msg_type == "say-text":
            text = msg_data.get("text", "") if isinstance(msg_data, dict) else ""
            voice_id = msg_data.get("voice_id") if isinstance(msg_data, dict) else None
            if text:
                await task.queue_frame(InterruptionFrame())
                frames = []
                if voice_id:
                    # Only store the original voice if we don't already have a
                    # pending restore (avoids overwriting original with a
                    # temporary voice on back-to-back say-text calls).
                    if not say_text_restore_voice.get("voice_id"):
                        say_text_restore_voice["voice_id"] = tts._voice_id
                    frames.append(TTSUpdateSettingsFrame(settings={"voice_id": voice_id}))
                else:
                    say_text_restore_voice["voice_id"] = None
                frames.append(TTSSpeakFrame(text=text, append_to_context=False))
                if voice_id:
                    # Best-effort restore after speak completes. If an
                    # interruption cancels this frame, SayTextVoiceGuard
                    # will restore the voice before the next LLM response.
                    frames.append(
                        TTSUpdateSettingsFrame(
                            settings={"voice_id": say_text_restore_voice["voice_id"]}
                        )
                    )
                await task.queue_frames(frames)
            return

        # Handle say-text-dismiss: stop TTS, restore voice, resume normal pipeline
        if msg_type == "say-text-dismiss":
            await task.queue_frame(InterruptionFrame())
            restore_id = say_text_restore_voice.get("voice_id")
            frames = []
            if restore_id:
                frames.append(TTSUpdateSettingsFrame(settings={"voice_id": restore_id}))
                say_text_restore_voice["voice_id"] = None
            await task.queue_frames(frames)
            return

        # Handle user text input messages
        if msg_type == "user-text-input":
            text = msg_data.get("text", "") if isinstance(msg_data, dict) else ""
            await task.queue_frame(UserTextInputFrame(text=text))
            if user_mute_state["muted"]:
                try:
                    await asyncio.wait_for(user_unmuted_event.wait(), timeout=0.5)
                except asyncio.TimeoutError:
                    logger.warning("Timed out waiting for user unmute after text input")
            frames = [InterruptionFrame()]
            if text.strip():
                logger.info(f"[USER-TEXT-INPUT] Received text: {text}")
                frames.extend(
                    [
                        UserStartedSpeakingFrame(),
                        TranscriptionFrame(
                            text=text, user_id="player", timestamp=time_now_iso8601()
                        ),
                        UserStoppedSpeakingFrame(),
                    ]
                )
            await task.queue_frames(frames)
            return

        # Assign a quest to the player
        if msg_type == "assign-quest":
            quest_code = msg_data.get("quest_code", "") if isinstance(msg_data, dict) else ""
            if not quest_code:
                logger.warning("assign-quest: missing quest_code")
                return
            try:
                result = await task_manager.game_client.assign_quest(
                    quest_code=quest_code,
                    character_id=task_manager.character_id,
                )
                logger.info(f"assign-quest result: {result}")
            except Exception as e:
                logger.error(f"assign-quest failed: {e}")
            return

        # Client sent a custom message
        if msg_type == "custom-message":
            text = msg_data.get("text", "") if isinstance(msg_data, dict) else ""
            if text:
                await rtvi.send_server_message(
                    {"type": "message-received", "text": f"Received: {text}"}
                )

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        """Handle new connection."""
        logger.info("Client connected")

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        """Handle disconnection."""
        logger.info("Client disconnected")
        await _shutdown("client disconnected")
        logger.info("Bot stopped")

    # Create runner and run the task
    runner = PipelineRunner(handle_sigint=getattr(runner_args, "handle_sigint", False))
    try:
        logger.info("Starting pipeline runner…")
        await runner.run(task)
        logger.info("Pipeline runner finished")
    except asyncio.CancelledError:
        await _shutdown("run_bot cancelled")
        raise
    except Exception as e:
        logger.exception(f"Pipeline runner error: {e}")
        await _shutdown("pipeline runner error")
    finally:
        await _shutdown("run_bot exit")


async def bot(runner_args: RunnerArguments):
    """Main bot entry point"""

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

    # Pipecat 0.0.95+ - runner_args is already the correct transport-specific type
    # (DailyRunnerArguments or SmallWebRTCRunnerArguments)
    transport = await create_transport(runner_args, transport_params)
    await run_bot(transport, runner_args)


if __name__ == "__main__":
    from pipecat.runner.run import main

    main()
