"""Custom user mute strategies for the voice pipeline."""

from pipecat.frames.frames import BotStoppedSpeakingFrame, Frame
from pipecat.turns.user_mute.base_user_mute_strategy import BaseUserMuteStrategy

from gradientbang.pipecat_server.frames import UserTextInputFrame


class TextInputBypassFirstBotMuteStrategy(BaseUserMuteStrategy):
    """Mute user input until the bot's first speech completes, unless text arrives.

    When ``force_mute`` is True, the strategy always returns muted regardless
    of bot speech or text input. Used during the scripted tutorial to keep the
    user muted for the entire duration.
    """

    def __init__(self):
        super().__init__()
        self._first_speech_handled = False
        self._force_mute = False

    @property
    def force_mute(self) -> bool:
        return self._force_mute

    @force_mute.setter
    def force_mute(self, value: bool) -> None:
        self._force_mute = value

    async def reset(self):
        """Reset the strategy to its initial state."""
        self._first_speech_handled = False

    async def process_frame(self, frame: Frame) -> bool:
        """Process an incoming frame.

        Returns:
            Whether the strategy should be muted.
        """
        await super().process_frame(frame)

        if self._force_mute:
            return True

        if isinstance(frame, UserTextInputFrame):
            self._first_speech_handled = True
            return False

        if isinstance(frame, BotStoppedSpeakingFrame):
            self._first_speech_handled = True

        return not self._first_speech_handled
