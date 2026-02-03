import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv
from loguru import logger
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    BotSpeakingFrame,
    InterruptionFrame,
    LLMRunFrame,
    StartFrame,
    StopFrame,
    TranscriptionFrame,
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
from pipecat.processors.frameworks.rtvi import (
    RTVIConfig,
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

from gradientbang.utils.llm_factory import create_llm_service, get_voice_llm_config
from gradientbang.utils.prompt_loader import build_voice_agent_prompt

load_dotenv(dotenv_path=".env.bot")

if os.getenv("BOT_USE_KRISP"):
    from pipecat.audio.filters.krisp_viva_filter import KrispVivaFilter


from gradientbang.pipecat_server.context_compression import (
    ContextCompressionConsumer,
    ContextCompressionProducer,
)
from gradientbang.pipecat_server.frames import TaskActivityFrame
from gradientbang.pipecat_server.inference_gate import (
    InferenceGateState,
    PostLLMInferenceGate,
    PreLLMInferenceGate,
)
from gradientbang.pipecat_server.voice_task_manager import VoiceTaskManager
from gradientbang.utils.supabase_client import AsyncGameClient
from gradientbang.utils.token_usage_logging import TokenUsageMetricsProcessor

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

    # Create RTVI processor with config
    rtvi = RTVIProcessor(config=RTVIConfig(config=[]))

    server_url = os.getenv("SUPABASE_URL")
    if not server_url:
        raise RuntimeError("SUPABASE_URL is required to run the bot.")
    logger.info(f"Using Supabase URL: {server_url}")

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
    context_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            filter_incomplete_user_turns=True,
        ),
    )
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

    # Create pipeline with parallel compression branch
    logger.info("Create pipeline…")
    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            # rtvi,  # Add RTVI processor for transcription events
            pre_llm_gate,
            context_aggregator.user(),
            ParallelPipeline(
                # Main branch
                [
                    llm,
                    post_llm_gate,
                    token_usage_metrics,
                    tts,
                    context_aggregator.assistant(),
                    transport.output(),
                    compression_consumer,  # Receives compression results
                ],
                # Compression monitoring branch (sink)
                [compression_producer],
            ),
        ]
    )

    # Create task with RTVI observer
    # Configure idle_timeout_frames to include TaskActivityFrame so long-running tasks
    # don't cause the pipeline to timeout when there's no voice interaction
    logger.info("Create task…")
    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            allow_interruptions=True,
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
        rtvi_processor=rtvi,
        idle_timeout_frames=(BotSpeakingFrame, UserStartedSpeakingFrame, TaskActivityFrame),
    )

    @rtvi.event_handler("on_client_ready")
    async def on_client_ready(rtvi):
        async def _join():
            await asyncio.sleep(2)
            await task_manager.game_client.pause_event_delivery()
            await task_manager.join()
            await task_manager.game_client.resume_event_delivery()

        asyncio.create_task(_join())
        await rtvi.set_bot_ready()

    @rtvi.event_handler("on_client_message")
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

        if msg_type == "get-my-map":
            try:
                if not isinstance(msg_data, dict):
                    raise ValueError("Message data must be an object")

                center_sector = msg_data.get("center_sector")
                if center_sector is None:
                    raise ValueError("Missing required field 'center_sector'")
                center_sector = int(center_sector)

                max_sectors_raw = msg_data.get("max_sectors")
                max_hops_raw = msg_data.get("max_hops")

                max_hops = int(max_hops_raw) if max_hops_raw is not None else 3
                if max_hops < 0 or max_hops > 100:
                    raise ValueError("max_hops must be between 0 and 100")

                max_sectors = int(max_sectors_raw) if max_sectors_raw is not None else 1000
                if max_sectors <= 0:
                    raise ValueError("max_sectors must be positive")

                # Use local_map_region endpoint
                await task_manager.game_client.local_map_region(
                    character_id=task_manager.character_id,
                    center_sector=center_sector,
                    max_hops=max_hops,
                    max_sectors=max_sectors,
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

        # Handle user text input messages
        if msg_type == "user-text-input":
            text = msg_data.get("text", "") if isinstance(msg_data, dict) else ""
            if text:
                logger.info(f"[USER-TEXT-INPUT] Received text: {text}")
                await task.queue_frames(
                    [
                        InterruptionFrame(),
                        UserStartedSpeakingFrame(),
                        TranscriptionFrame(
                            text=text, user_id="player", timestamp=time_now_iso8601()
                        ),
                        UserStoppedSpeakingFrame(),
                    ]
                )
            return

        # Client sent a custom message
        if msg_type == "custom-message":
            text = msg_data.get("text", "") if isinstance(msg_data, dict) else ""
            if text:
                logger.info(f"!!! TODO: Process custom message: {text}")
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
        await task.cancel()
        await task_manager.close()
        logger.info("Bot stopped")

    # Create runner and run the task
    runner = PipelineRunner(handle_sigint=getattr(runner_args, "handle_sigint", False))
    try:
        logger.info("Starting pipeline runner…")
        await runner.run(task)
        logger.info("Pipeline runner finished")
    except Exception as e:
        logger.exception(f"Pipeline runner error: {e}")


async def bot(runner_args: RunnerArguments):
    """Main bot entry point"""

    logger.info(f"Bot started with runner_args: {runner_args}")

    transport_params = {
        "daily": lambda: DailyParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=0.2)),
            audio_in_filter=(KrispVivaFilter() if os.getenv("BOT_USE_KRISP") else None),
            turn_analyzer=LocalSmartTurnAnalyzerV3(),
        ),
        "webrtc": lambda: TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=0.2)),
            audio_in_filter=(KrispVivaFilter() if os.getenv("BOT_USE_KRISP") else None),
            turn_analyzer=LocalSmartTurnAnalyzerV3(),
        ),
    }

    # Pipecat 0.0.95+ - runner_args is already the correct transport-specific type
    # (DailyRunnerArguments or SmallWebRTCRunnerArguments)
    transport = await create_transport(runner_args, transport_params)
    await run_bot(transport, runner_args)


if __name__ == "__main__":
    from pipecat.runner.run import main

    main()
