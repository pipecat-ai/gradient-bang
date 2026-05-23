"""Daily.co room recording configuration.

Calls Daily's REST API to enable raw-track recording on a room and tell
Daily where to push the resulting files (S3 bucket / region / assume-role
ARN). No S3 I/O happens here — Daily writes the recordings.

Invoked once per session from bot.py when the transport is Daily.
"""

from urllib.parse import urlparse

import aiohttp
from loguru import logger

from gradientbang.config import settings


async def configure_recording_bucket(room_url: str) -> None:
    if not all(
        [
            settings.DAILY_RECORDING_BUCKET_NAME,
            settings.DAILY_RECORDING_BUCKET_REGION,
            settings.DAILY_RECORDING_ASSUME_ROLE_ARN,
        ]
    ):
        logger.debug("Recording bucket env vars not set, skipping room config")
        return

    if not settings.DAILY_API_KEY:
        logger.warning("DAILY_API_KEY not set, cannot configure recording bucket")
        return

    room_name = urlparse(room_url).path.lstrip("/")
    url = f"https://api.daily.co/v1/rooms/{room_name}"
    headers = {"Authorization": f"Bearer {settings.DAILY_API_KEY}"}
    body = {
        "properties": {
            "enable_recording": "raw-tracks",
            "enable_raw_tracks_event_json": True,
            "enable_raw_tracks_transcoded_audio": "aac",
            "recordings_bucket": {
                "bucket_name": settings.DAILY_RECORDING_BUCKET_NAME,
                "bucket_region": settings.DAILY_RECORDING_BUCKET_REGION,
                "assume_role_arn": settings.DAILY_RECORDING_ASSUME_ROLE_ARN,
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


async def start_raw_tracks_recording(transport) -> None:
    """Kick off raw-tracks recording on a Daily room once the bot has joined.

    No-op for non-Daily transports and when the bucket isn't configured.
    """
    if not hasattr(transport, "start_recording"):
        return
    if not settings.DAILY_RECORDING_BUCKET_NAME:
        return

    logger.info("Starting raw-tracks recording")
    try:
        stream_id, error = await transport.start_recording(
            {"layout": {"preset": "audio-only"}}, None, False
        )
        if error:
            logger.error(f"Failed to start recording: {error}")
        else:
            logger.info(f"Recording started (stream_id={stream_id})")
    except Exception as exc:
        logger.error(f"Failed to start recording: {exc}")
