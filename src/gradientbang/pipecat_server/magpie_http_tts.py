"""HTTP client for Magpie TTS server.

Connects to a Magpie-compatible HTTP server exposing /v1/audio/speech.
"""

from typing import AsyncGenerator, Optional

import httpx
from loguru import logger
from pydantic import BaseModel

from pipecat.frames.frames import (
    ErrorFrame,
    Frame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
)
from pipecat.services.tts_service import TTSService

# Magpie server default sample rate.
DEFAULT_SAMPLE_RATE = 22000


class MagpieHTTPTTSService(TTSService):
    """HTTP client for Magpie TTS."""

    class InputParams(BaseModel):
        """Input parameters for Magpie HTTP TTS."""

        language: str = "en"

    def __init__(
        self,
        *,
        server_url: str = "http://192.168.7.228:8001",
        voice: str = "aria",
        language: str = "en",
        sample_rate: Optional[int] = None,
        params: Optional[InputParams] = None,
        **kwargs,
    ):
        # sample_rate may be updated after fetching /v1/audio/config.
        super().__init__(sample_rate=sample_rate or DEFAULT_SAMPLE_RATE, **kwargs)

        params = params or MagpieHTTPTTSService.InputParams()

        normalized_url = server_url.rstrip("/")
        if normalized_url.endswith("/v1/audio/speech"):
            normalized_url = normalized_url[: -len("/v1/audio/speech")]
        self._server_url = normalized_url
        self._voice = voice.lower()
        self._language = language.lower()
        self._sample_rate = sample_rate

        self._client = httpx.AsyncClient(timeout=30.0)
        self._config_fetched = False

        self.set_model_name("magpie-http")
        self.set_voice(voice)
        self.set_language(params.language or language)

        logger.info(
            f"MagpieHTTPTTS initialized: server={self._server_url}, "
            f"voice={self._voice}, language={self._language}"
        )

    async def _ensure_config(self):
        """Fetch server config once to pick up sample rate and voice metadata."""
        if self._config_fetched:
            return

        try:
            resp = await self._client.get(f"{self._server_url}/v1/audio/config")
            if resp.status_code == 200:
                config = resp.json()
                server_sample_rate = int(config.get("sample_rate", DEFAULT_SAMPLE_RATE))

                if self._sample_rate is None:
                    self._sample_rate = server_sample_rate
                    self._settings.sample_rate = server_sample_rate

                logger.info(
                    f"MagpieHTTPTTS config: sample_rate={server_sample_rate}Hz, "
                    f"voices={config.get('voices', [])}"
                )
            self._config_fetched = True
        except Exception as exc:
            logger.warning(f"Failed to fetch Magpie TTS config: {exc}")
            self._config_fetched = True

    def can_generate_metrics(self) -> bool:
        return True

    async def run_tts(self, text: str) -> AsyncGenerator[Frame, None]:
        await self.start_ttfb_metrics()
        yield TTSStartedFrame()

        await self._ensure_config()

        # Normalize common punctuation forms before synthesis.
        text = text.replace("\u2018", "'")
        text = text.replace("\u2019", "'")
        text = text.replace("\u201C", '"')
        text = text.replace("\u201D", '"')
        text = text.replace("\u2014", "-")
        text = text.replace("\u2013", "-")

        try:
            resp = await self._client.post(
                f"{self._server_url}/v1/audio/speech",
                json={
                    "input": text,
                    "voice": self._voice,
                    "language": self._language,
                    "response_format": "pcm",
                },
            )

            if resp.status_code != 200:
                error_msg = f"TTS server error: {resp.status_code} - {resp.text}"
                logger.error(error_msg)
                yield ErrorFrame(error=error_msg)
                yield TTSStoppedFrame()
                return

            await self.stop_ttfb_metrics()

            audio_bytes = resp.content
            sample_rate = int(resp.headers.get("X-Sample-Rate", self._sample_rate or DEFAULT_SAMPLE_RATE))

            yield TTSAudioRawFrame(
                audio=audio_bytes,
                sample_rate=sample_rate,
                num_channels=1,
            )
            await self.start_tts_usage_metrics(text)
            yield TTSStoppedFrame()
        except httpx.ConnectError as exc:
            error_msg = f"Cannot connect to TTS server at {self._server_url}: {exc}"
            logger.error(error_msg)
            yield ErrorFrame(error=error_msg)
            yield TTSStoppedFrame()
        except Exception as exc:
            logger.error(f"MagpieHTTPTTS error: {exc}")
            yield ErrorFrame(error=str(exc))
            yield TTSStoppedFrame()

    async def close(self):
        await self._client.aclose()

    def set_voice(self, voice: str):
        self._voice = voice.lower()
        super().set_voice(voice)

    def set_language(self, language: str):
        self._language = language.lower()
