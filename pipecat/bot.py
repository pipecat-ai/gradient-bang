"""
Interruptible bot using LocalMacTransport (or other transports via runner args).
Uses RTVI for client messages and manages task/tools.
"""

import asyncio
import os
import sys

# Ensure imports work whether run as a script, a module, or imported by path
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(os.path.dirname(_THIS_DIR))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from dotenv import load_dotenv
from loguru import logger

from pipecat.services.cartesia.tts import CartesiaTTSService
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import (
    Frame,
    LLMMessagesAppendFrame,
    StartFrame,
    StopFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.services.openai.base_llm import BaseOpenAILLMService
from pipecat.processors.aggregators.openai_llm_context import (
    OpenAILLMContext,
    OpenAILLMContextFrame,
)
from pipecat.processors.frameworks.rtvi import (
    RTVIConfig,
    RTVIObserver,
    RTVIProcessor,
    RTVIServerMessageFrame,
)
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection
from pipecat.services.speechmatics.stt import SpeechmaticsSTTService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.base_transport import TransportParams
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport

from utils.prompts import GAME_DESCRIPTION, CHAT_INSTRUCTIONS, VOICE_INSTRUCTIONS

try:
    # Prefer package import when available
    from pipecat.voice_task_manager import VoiceTaskManager
except Exception:  # Fallback when imported directly by file path
    from voice_task_manager import VoiceTaskManager


load_dotenv()

logger.remove()
logger.add(sys.stderr, level="INFO")


class TaskProgressInserter(FrameProcessor):
    def __init__(self, voice_task_manager: VoiceTaskManager):
        super().__init__()
        self._voice_task_manager = voice_task_manager

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, OpenAILLMContextFrame):
            task_buffer = self._voice_task_manager.get_task_progress()
            if task_buffer.strip():
                frame.context.messages.insert(
                    len(frame.context.messages) - 1,
                    {
                        "role": "user",
                        "content": f"Task Progress:\n{task_buffer}",
                    },
                )

        await self.push_frame(frame, direction)


def create_chat_system_prompt() -> str:
    """Create the system prompt for the chat agent."""
    return f"""{GAME_DESCRIPTION}
{CHAT_INSTRUCTIONS}
{VOICE_INSTRUCTIONS}
"""


async def run_bot(transport, runner_args: RunnerArguments):
    """Main bot function that creates and runs the pipeline."""
    # Create RTVI processor with config
    rtvi = RTVIProcessor(config=RTVIConfig(config=[]))

    def task_complete_callback(was_cancelled: bool, via_stop_tool: bool = False):
        """Notify client and request a brief summary from the LLM."""

        async def _complete():
            await rtvi.push_frame(
                RTVIServerMessageFrame(
                    {
                        "gg-action": "task-complete",
                        "was_cancelled": was_cancelled,
                        "via_stop_tool": via_stop_tool,
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
    initial_status = await task_manager.join()
    initial_map_data = await task_manager.game_client.my_map()

    # Initialize STT service
    logger.info("Init STT…")
    stt = SpeechmaticsSTTService(
        api_key=os.getenv("SPEECHMATICS_API_KEY"), enable_speaker_diarization=False
    )

    # Initialize TTS service (managed session)
    logger.info("Init TTS (Cartesia)…")
    cartesia_key = os.getenv("CARTESIA_API_KEY", "")
    if not cartesia_key:
        logger.warning("CARTESIA_API_KEY is not set; TTS may fail.")
    tts = CartesiaTTSService(api_key=cartesia_key, voice_id="d7862948-75c3-4c7c-ae28-2959fe166f49")

    # Initialize LLM service
    logger.info("Init LLM…")
    llm = OpenAILLMService(
        api_key=os.getenv("OPENAI_API_KEY"),
        model="gpt-4.1",
        params=BaseOpenAILLMService.InputParams(extra={"service_tier": "priority"}),
    )
    llm.register_function(None, task_manager.execute_tool_call)

    task_progress = TaskProgressInserter(task_manager)

    # System prompt
    messages = [
        {
            "role": "system",
            "content": create_chat_system_prompt(),
        }
    ]

    # Create context aggregator
    context = OpenAILLMContext(messages, tools=task_manager.get_tools_schema())
    context_aggregator = llm.create_context_aggregator(context)

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
        # Dispatch initialization data to client
        await rtvi.push_frame(
            RTVIServerMessageFrame(
                {
                    "gg-action": "init",
                    "result": initial_status,
                    "map_data": initial_map_data,
                }
            )
        )
        await rtvi.set_bot_ready()
        # Kick off the conversation
        await task.queue_frames([context_aggregator.user().get_context_frame()])

    @rtvi.event_handler("on_client_message")
    async def on_client_message(rtvi, message):
        """Handle custom messages from the client."""
        logger.info(f"Received client message: {message}")

        # Extract message type and data from RTVIClientMessage object
        msg_type = message.type
        msg_data = message.data if hasattr(message, "data") else {}

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
            # Get current status from the task manager
            status = await task_manager.game_client.my_status()
            await rtvi.push_frame(
                RTVIServerMessageFrame({"gg-action": "my_status", "result": status})
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
        # Proactively send init in case client_ready doesn't fire in this environment
        try:
            await rtvi.push_frame(
                RTVIServerMessageFrame(
                    {
                        "gg-action": "init",
                        "result": initial_status,
                        "map_data": initial_map_data,
                    }
                )
            )
        except Exception:
            logger.exception("Failed to send init on connect")

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


async def bot(runner_args: RunnerArguments):
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
            vad_analyzer=SileroVADAnalyzer(),
            # turn_analyzer=LocalSmartTurnAnalyzerV2(
            #     smart_turn_model_path=None, params=SmartTurnParams()
            # ),
        ),
    }

    transport = await create_transport(runner_args, transport_params)
    await run_bot(transport, runner_args)


if __name__ == "__main__":
    # Support a simple local run mode for development: `python -m pipecat.bot -t local`
    # Falls back to the standard runner (pipecat.runner.run::main) otherwise.
    import argparse
    from macos.local_mac_transport import LocalMacTransport, LocalMacTransportParams

    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("-t", "--t", default=None)
    known, _ = parser.parse_known_args()

    if known.t == "local":
        from pipecat.audio.vad.silero import SileroVADAnalyzer
        from loguru import logger
        import asyncio as _asyncio

        logger.info("Using new AEC transport (LocalMacTransport)")
        params = LocalMacTransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            vad_analyzer=SileroVADAnalyzer(),
        )
        transport = LocalMacTransport(params=params)
        _asyncio.run(run_bot(transport, RunnerArguments()))
    else:
        from pipecat.runner.run import main

        main()
