"""
Interruptible bot using SmallWebRTCTransport.
Based on Pipecat's 07-interruptible.py example.
"""

import asyncio
import os
import sys

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv
from loguru import logger

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import (
    TranscriptionFrame,
    StartInterruptionFrame,
    StopInterruptionFrame,
    LLMMessagesAppendFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.services.openai.base_llm import BaseOpenAILLMService
from pipecat.processors.aggregators.openai_llm_context import OpenAILLMContext
from pipecat.processors.frameworks.rtvi import (
    RTVIConfig,
    RTVIObserver,
    RTVIProcessor,
    RTVIServerMessageFrame,
)
from pipecat.services.cartesia.tts import CartesiaTTSService
from pipecat.services.speechmatics.stt import SpeechmaticsSTTService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.base_transport import TransportParams
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport

from utils.prompts import GAME_DESCRIPTION, CHAT_INSTRUCTIONS
from voice_task_manager import VoiceTaskManager


load_dotenv()

logger.remove()
logger.add(sys.stderr, level="DEBUG")


def create_chat_system_prompt() -> str:
    """Create the system prompt for the chat agent."""
    return f"""{GAME_DESCRIPTION}

{CHAT_INSTRUCTIONS}"""


async def run_bot(transport):
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

    # khk TODO
    #   :
    #   - implement task progress buffer context for each voice inference, as in the TUI
    #   - look again to be sure task_complete_callback is good code
    #   - check that messages are similar to those we're using in the tui
    task_manager = VoiceTaskManager(
        character_id="TraderP",
        rtvi_processor=rtvi,
        task_complete_callback=task_complete_callback,
    )
    await task_manager.join()

    # Initialize STT service
    stt = SpeechmaticsSTTService(
        api_key=os.getenv("SPEECHMATICS_API_KEY"),
        enable_speaker_diarization=False,
    )

    # Initialize TTS service
    tts = CartesiaTTSService(
        api_key=os.getenv("CARTESIA_API_KEY"),
        voice_id="79a125e8-cd45-4c13-8a67-188112f4dd22",  # British Lady
    )

    # Initialize LLM service
    llm = OpenAILLMService(
        api_key=os.getenv("OPENAI_API_KEY"),
        model="gpt-4.1",
        params=BaseOpenAILLMService.InputParams(
            extra={"service_tier": "priority"},
        ),
    )
    llm.register_function(None, task_manager.execute_tool_call)

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
    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            rtvi,  # Add RTVI processor for transcription events
            context_aggregator.user(),
            llm,
            tts,
            transport.output(),
            context_aggregator.assistant(),
        ]
    )

    # Create task with RTVI observer
    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            allow_interruptions=True,
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
        observers=[RTVIObserver(rtvi)],
    )

    @rtvi.event_handler("on_client_ready")
    async def on_client_ready(rtvi):
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

        if msg_type == "custom-message":
            text = msg_data.get("text", "") if isinstance(msg_data, dict) else ""
            if text:
                # Process the text message as user input
                logger.info(f"Processing custom message: {text}")
                # Send the text as a TranscriptionFrame which will be processed by the
                # context aggregator
                await task.queue_frames(
                    [
                        StartInterruptionFrame(),
                        TranscriptionFrame(
                            text=text,
                            user_id="text-input",
                            timestamp="",
                        ),
                        StopInterruptionFrame(),
                    ]
                )

                # Send acknowledgment back to client
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
    runner = PipelineRunner(handle_sigint=False)
    await runner.run(task)


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
    await run_bot(transport)


if __name__ == "__main__":
    from pipecat.runner.run import main

    main()
