"""
Interruptible bot using SmallWebRTCTransport.
Based on Pipecat's 07-interruptible.py example.
"""

import asyncio
import os
import sys
from typing import Optional

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv
from loguru import logger

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.turn.smart_turn.base_smart_turn import SmartTurnParams
from pipecat.audio.turn.smart_turn.local_smart_turn_v2 import LocalSmartTurnAnalyzerV2
from pipecat.frames.frames import (
    TranscriptionFrame,
    StartInterruptionFrame,
    StopInterruptionFrame,
    LLMMessagesAppendFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
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
from pipecat.transports.network.small_webrtc import SmallWebRTCTransport
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.processors.frame_processor import FrameProcessor

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

    task_progress_buffer = []

    def progress_callback(action, description):
        """Synchronous callback that schedules async frame push."""
        logger.info(f"Task progress: {action} - {description}")
        task_progress_buffer.append({"action": action, "description": description})
        # Schedule the async operation without waiting
        asyncio.create_task(
            rtvi.push_frame(
                RTVIServerMessageFrame(
                    {
                        "gg-action": "task-progress",
                        "action": action,
                        "description": description,
                    }
                )
            )
        )

    def task_complete_callback(was_cancelled, via_stop_tool=False):
        """Synchronous callback that schedules async frame push."""
        logger.info(
            f"Task complete: cancelled={was_cancelled}, via_stop_tool={via_stop_tool}"
        )

        async def _complete():
            logger.info("Task complete: pushing frames")
            await rtvi.push_frame(
                RTVIServerMessageFrame(
                    {
                        "gg-action": "task-complete",
                        "was_cancelled": was_cancelled,
                        "via_stop_tool": via_stop_tool,
                    }
                )
            )
            # Format task progress buffer as a string
            task_log = "\n".join(
                [
                    f"{item['action']}: {item['description']}"
                    for item in task_progress_buffer
                ]
            )

            if was_cancelled:
                prompt = f"The task was cancelled. Please acknowledge the cancellation and summarize what was done before stopping.\n<task_log>\n{task_log}\n</task_log>"
            else:
                prompt = f"Task completed. Please summarize what was accomplished.\n<task_log>\n{task_log}\n</task_log>"
            task_progress_buffer.clear()
            logger.info("Okay, pushing LLMMessagesAppendFrame")
            await rtvi.push_frame(
                LLMMessagesAppendFrame(
                    messages=[{"role": "user", "content": prompt}],
                    run_llm=True,
                )
            )

        asyncio.create_task(_complete())

    task_manager = VoiceTaskManager(
        character_id="TraderP",
        output_callback=None,
        progress_callback=progress_callback,
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
    )
    llm.register_function("move", task_manager.tool_move)
    llm.register_function("my_status", task_manager.tool_my_status)
    llm.register_function("my_map", task_manager.tool_my_map)
    llm.register_function("start_task", task_manager.tool_start_task)
    llm.register_function("stop_task", task_manager.tool_stop_task)

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
                # Send the text as a TranscriptionFrame which will be processed by the context aggregator
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
