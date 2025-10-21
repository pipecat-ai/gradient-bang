from pipecat.utils.time import time_now_iso8601
from pipecat.runner.utils import create_transport
from pipecat.runner.types import RunnerArguments
from pipecat.transports.daily.transport import DailyParams
from pipecat.transports.base_transport import TransportParams
from pipecat.services.google.llm import GoogleLLMService
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection
from pipecat.processors.frameworks.rtvi import (
    RTVIConfig,
    RTVIObserver,
    RTVIProcessor,
    RTVIServerMessageFrame,
)
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.pipeline import Pipeline
from pipecat.frames.frames import (
    Frame,
    LLMContextFrame,
    InterruptionFrame,
    LLMMessagesAppendFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    TranscriptionFrame,
    StartFrame,
    StopFrame,
    LLMRunFrame,
)
from pipecat.services.cartesia.tts import CartesiaTTSService
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
)
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.audio.vad.vad_analyzer import VADParams
from loguru import logger
from dotenv import load_dotenv
import asyncio
import os
import sys

# Ensure imports work whether run as a script, a module, or imported by path

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_THIS_DIR)
print(_THIS_DIR)
print(_REPO_ROOT)
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from utils.prompts import GAME_DESCRIPTION, CHAT_INSTRUCTIONS, VOICE_INSTRUCTIONS

try:
    # Prefer package import when available
    from pipecat.voice_task_manager import VoiceTaskManager
except Exception:  # Fallback when imported directly by file path
    from voice_task_manager import VoiceTaskManager


load_dotenv()

# Configure loguru
logger.remove()
logger.add(sys.stderr, level="INFO")


class TaskProgressInserter(FrameProcessor):
    def __init__(self, voice_task_manager: VoiceTaskManager):
        super().__init__()
        self._voice_task_manager = voice_task_manager

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMContextFrame):
            task_buffer = self._voice_task_manager.get_task_progress()
            if task_buffer.strip():
                frame.context._messages.insert(
                    len(frame.context._messages) - 1,
                    {
                        "role": "user",
                        "content": f"<task_progress>{task_buffer}</task_progress>",
                    },
                )

        await self.push_frame(frame, direction)


def create_chat_system_prompt() -> str:
    """Create the system prompt for the chat agent."""
    return f"""{GAME_DESCRIPTION}
{CHAT_INSTRUCTIONS}
{VOICE_INSTRUCTIONS}
"""


async def run_bot(transport, runner_args: RunnerArguments, **kwargs):
    """Main bot function that creates and runs the pipeline."""
    # Create RTVI processor with config
    rtvi = RTVIProcessor(config=RTVIConfig(config=[]))

    def task_complete_callback(was_cancelled: bool, via_stop_tool: bool = False):
        """Notify client and request a brief summary from the LLM."""

        async def _complete():
            await rtvi.push_frame(
                RTVIServerMessageFrame(
                    {
                        "frame_type": "event",
                        "event": "task_complete",
                        "gg-action": "task_complete",
                        "payload": {
                            "was_cancelled": was_cancelled,
                            "via_stop_tool": via_stop_tool,
                        },
                    }
                )
            )

            # Ask the LLM to summarize completion
            prompt = (
                "The task was cancelled. Please acknowledge the cancellation and summarize what was done before stopping."
                if was_cancelled
                else "Task completed. Please summarize what was accomplished."
            )
            await rtvi.push_frame(
                LLMMessagesAppendFrame(
                    messages=[{"role": "user", "content": prompt}],
                    run_llm=True,
                )
            )

        asyncio.create_task(_complete())

    # Create voice task manager
    task_manager = VoiceTaskManager(
        character_id="TraderP",
        rtvi_processor=rtvi,
        task_complete_callback=task_complete_callback,
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
    tts = CartesiaTTSService(
        api_key=cartesia_key, voice_id="d7862948-75c3-4c7c-ae28-2959fe166f49"
    )

    # Initialize LLM service
    logger.info("Init LLM…")
    llm = GoogleLLMService(
        api_key=os.getenv("GOOGLE_API_KEY"),
        model="gemini-2.5-flash-preview-09-2025",
    )
    llm.register_function(None, task_manager.execute_tool_call)

    task_progress = TaskProgressInserter(task_manager)

    # System prompt
    messages = [
        {
            "role": "system",
            "content": create_chat_system_prompt(),
        },
        {
            "role": "user",
            "content": "<start_of_session>Character Name: TraderP</start_of_session>",
        },
    ]

    # Create context aggregator
    context = LLMContext(messages, tools=task_manager.get_tools_schema())
    context_aggregator = LLMContextAggregatorPair(context)

    # Create pipeline
    logger.info("Create pipeline…")
    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            rtvi,  # Add RTVI processor for transcription events
            context_aggregator.user(),
            task_progress,
            llm,
            tts,
            transport.output(),
            context_aggregator.assistant(),
        ]
    )

    # Create task with RTVI observer
    logger.info("Create task…")
    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            allow_interruptions=True,
            enable_metrics=False,
            enable_usage_metrics=False,
        ),
        observers=[RTVIObserver(rtvi)],
    )

    @rtvi.event_handler("on_client_ready")
    async def on_client_ready(rtvi):
        async def _join():
            await asyncio.sleep(2)
            await task_manager.game_client.pause_event_delivery()
            await task_manager.join()
            await task_manager.game_client.local_map_region(
                character_id=task_manager.character_id,
            )
            await task_manager.game_client.resume_event_delivery()

        asyncio.create_task(_join())

        # # Dispatch initialization data to client
        # await rtvi.push_frame(
        #     RTVIServerMessageFrame(
        #         {
        #             "frame_type": "event",
        #             "event": "status.update",
        #             "payload": initial_status,
        #         }
        #     )
        # )

        # try:
        #     current_sector = initial_status.get("sector", {}).get("id")
        #     if current_sector is not None:
        #         map_data = await task_manager.game_client.local_map_region(
        #             character_id=task_manager.character_id,
        #             center_sector=current_sector,
        #             max_hops=4,
        #             max_sectors=28,
        #         )
        #         await rtvi.push_frame(
        #             RTVIServerMessageFrame(
        #                 {
        #                     "frame_type": "event",
        #                     "event": "map.local",
        #                     "payload": map_data,
        #                 }
        #             )
        #         )
        # except Exception as exc:
        #     logger.exception("Failed to send initial map")

        await rtvi.set_bot_ready()

        # Kick off the conversation
        if runner_args.body.get("start_on_join", True):
            await task.queue_frames([LLMRunFrame()])

    @rtvi.event_handler("on_client_message")
    async def on_client_message(rtvi, message):
        """Handle custom messages from the client."""
        logger.info(f"Received client message: {message}")

        # Extract message type and data from RTVIClientMessage object
        msg_type = message.type
        msg_data = message.data if hasattr(message, "data") else {}

        # Start (for web client)
        if msg_type == "start":
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
                logger.info(
                    f"Microphone {'muted' if mute else 'unmuted'} (transport flag)"
                )
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
            # Get current status from the task manager
            status = await task_manager.game_client.my_status(task_manager.character_id)
            await rtvi.push_frame(
                RTVIServerMessageFrame(
                    {
                        "frame_type": "event",
                        "event": "status.update",
                        "payload": status,
                    }
                )
            )
            return

        # Client requested known ports
        if msg_type == "get-known-ports":
            status = await task_manager.game_client.list_known_ports(
                task_manager.character_id
            )
            await rtvi.push_frame(
                RTVIServerMessageFrame(
                    {
                        "frame_type": "event",
                        "event": "map.known-ports",
                        "payload": status,
                    }
                )
            )
            return

        if msg_type == "get-local-map":
            try:
                if not isinstance(msg_data, dict):
                    raise ValueError("Message data must be an object")

                sector = msg_data.get("sector")
                if sector is None:
                    raise ValueError("Missing required field 'sector'")
                sector = int(sector)

                max_sectors_raw = msg_data.get("max_sectors")
                max_hops_raw = msg_data.get("max_hops")

                max_hops = int(max_hops_raw) if max_hops_raw is not None else 3
                if max_hops < 0 or max_hops > 10:
                    raise ValueError("max_hops must be between 0 and 10")

                max_sectors = (
                    int(max_sectors_raw) if max_sectors_raw is not None else 100
                )
                if max_sectors <= 0:
                    raise ValueError("max_sectors must be positive")

                # Use local_map_region endpoint
                map_data = await task_manager.game_client.local_map_region(
                    character_id=task_manager.character_id,
                    center_sector=sector,
                    max_hops=max_hops,
                    max_sectors=max_sectors,
                )

                await rtvi.push_frame(
                    RTVIServerMessageFrame(
                        {
                            "frame_type": "event",
                            "event": "map.local",
                            "payload": map_data,
                        }
                    )
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception("Failed to fetch local map region via client message")
                await rtvi.push_frame(
                    RTVIServerMessageFrame(
                        {
                            "frame_type": "event",
                            "event": "map.local",
                            "payload": {
                                "error": str(exc),
                                "center_sector": msg_data.get("sector")
                                if isinstance(msg_data, dict)
                                else None,
                            },
                        }
                    )
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
        logger.info("Bot stopped")

    # Create runner and run the task
    runner = PipelineRunner(handle_sigint=getattr(runner_args, "handle_sigint", False))
    try:
        logger.info("Starting pipeline runner…")
        await runner.run(task)
        logger.info("Pipeline runner finished")
    except Exception as e:
        logger.exception(f"Pipeline runner error: {e}")


async def bot(runner_args):
    """Main bot entry point compatible with standard bot starters, including Pipecat Cloud."""

    transport_params = {
        "daily": lambda: DailyParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            vad_analyzer=SileroVADAnalyzer(),
        ),
        "webrtc": lambda: TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=0.2)),
            turn_analyzer=LocalSmartTurnAnalyzerV3(),
        ),
    }

    transport = await create_transport(runner_args, transport_params)
    await run_bot(transport, runner_args)


if __name__ == "__main__":
    from pipecat.runner.run import main

    main()
