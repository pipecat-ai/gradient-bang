"""Custom user mute strategies for the voice pipeline."""

from pipecat.frames.frames import BotStoppedSpeakingFrame, Frame
from pipecat.turns.user_mute.base_user_mute_strategy import BaseUserMuteStrategy

from gradientbang.pipecat_server.frames import UserTextInputFrame


class TextInputBypassFirstBotMuteStrategy(BaseUserMuteStrategy):
    """Mute user input until the bot's first speech completes, unless text arrives."""

    def __init__(self):
        super().__init__()
        self._first_speech_handled = False

    async def reset(self):
        """Reset the strategy to its initial state."""
        self._first_speech_handled = False

    async def process_frame(self, frame: Frame) -> bool:
        """Process an incoming frame.

        Returns:
            Whether the strategy should be muted.
        """
        await super().process_frame(frame)

        if isinstance(frame, UserTextInputFrame):
            self._first_speech_handled = True
            return False

        if isinstance(frame, BotStoppedSpeakingFrame):
            self._first_speech_handled = True

        return not self._first_speech_handled
