"""LocalSmartTurnAnalyzerV3 subclass that uploads audio snippets to S3 as FLAC."""

import io
import os
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import numpy as np
from loguru import logger
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3


class S3SmartTurnAnalyzerV3(LocalSmartTurnAnalyzerV3):
    """Wraps LocalSmartTurnAnalyzerV3 and uploads each audio snippet to S3 as FLAC."""

    def __init__(
        self,
        *,
        player_id: str,
        s3_bucket: Optional[str] = None,
        aws_access_key_id: Optional[str] = None,
        aws_secret_access_key: Optional[str] = None,
        aws_region: Optional[str] = None,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._player_id = player_id
        self._s3_bucket = s3_bucket or os.getenv("SMART_TURN_S3_BUCKET", "")
        self._aws_access_key_id = aws_access_key_id or os.getenv("AWS_ACCESS_KEY_ID")
        self._aws_secret_access_key = aws_secret_access_key or os.getenv("AWS_SECRET_ACCESS_KEY")
        self._aws_region = aws_region or os.getenv("AWS_REGION", "us-east-1")

        if not self._s3_bucket:
            logger.warning("SMART_TURN_S3_BUCKET not set – S3 uploads disabled")

    def _predict_endpoint(self, audio_array: np.ndarray) -> Dict[str, Any]:
        result = super()._predict_endpoint(audio_array)

        if self._s3_bucket:
            audio_copy = audio_array.copy()
            label = "complete" if result["prediction"] == 1 else "incomplete"
            thread = threading.Thread(
                target=self._upload_to_s3, args=(audio_copy, label), daemon=True
            )
            thread.start()

        return result

    def _upload_to_s3(self, audio_array: np.ndarray, label: str) -> None:
        try:
            import soundfile as sf
            import boto3

            # Encode as FLAC into an in-memory buffer
            buf = io.BytesIO()
            sf.write(buf, audio_array, 16000, format="FLAC")
            buf.seek(0)

            now = datetime.now(timezone.utc)
            timestamp = now.strftime("%y-%m-%d-%H-%M-%S")
            key = f"{self._player_id}/{label}/{timestamp}-{uuid.uuid4()}.flac"

            client = boto3.client(
                "s3",
                region_name=self._aws_region,
                aws_access_key_id=self._aws_access_key_id,
                aws_secret_access_key=self._aws_secret_access_key,
            )
            client.upload_fileobj(buf, self._s3_bucket, key)
            logger.debug(f"Uploaded smart-turn audio to s3://{self._s3_bucket}/{key}")
        except Exception as e:
            logger.error(f"Failed to upload smart-turn audio to S3: {e}")
