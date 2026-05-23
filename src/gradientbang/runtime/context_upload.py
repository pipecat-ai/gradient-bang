"""Upload LLM context snapshots to S3 for debugging.

Uploads are fire-and-forget via daemon threads. The feature is opt-in:
set CONTEXT_S3_BUCKET to enable. Uses the same AWS credentials as
s3_smart_turn (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION).

A metadata row is upserted into the ``context_snapshots`` table via
PostgREST (using SUPABASE_SERVICE_ROLE_KEY) after each successful upload.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from loguru import logger

from gradientbang.config import settings
from gradientbang.utils.cekura_tracing import cekura_append_context_dump


class ContextNotFoundError(Exception):
    """Raised when no context snapshot exists for the requested task."""


def _get_config() -> Optional[Dict[str, str]]:
    """Return S3/DB config from settings, or None if the feature is disabled."""
    bucket = settings.CONTEXT_S3_BUCKET or ""
    if not bucket:
        return None
    supabase_url = (settings.SUPABASE_URL or "").rstrip("/")
    service_key = settings.SUPABASE_SERVICE_ROLE_KEY or ""
    return {
        "bucket": bucket,
        "aws_access_key_id": settings.AWS_ACCESS_KEY_ID,
        "aws_secret_access_key": settings.AWS_SECRET_ACCESS_KEY,
        "aws_region": settings.AWS_REGION,
        "supabase_rest_url": f"{supabase_url}/rest/v1" if supabase_url else "",
        "supabase_service_key": service_key,
    }


class VoiceContextUploader:
    """Voice-agent specific wrapper around `upload_context`.

    Owns per-session sequence numbering (each compaction era gets its own
    seq) and the skip-if-unchanged check for periodic uploads. Builds the
    s3_key and db_row in the voice-agent shape so bot.py just calls
    ``uploader.upload(reason)``.
    """

    def __init__(self, *, context: Any, character_id: str, session_id: str | None) -> None:
        self._context = context
        self._character_id = character_id
        self._session_id = session_id
        self._seq = 1
        self._last_uploaded_count = 0

    def upload(self, reason: str) -> None:
        # Compaction closes an era — bump seq for the new era regardless of
        # whether this specific upload succeeded, was skipped (empty msgs),
        # or raised. Matches the old bot.py pattern where the bump lived in
        # the handler and ran after the try/except.
        try:
            if not self._session_id:
                return  # Refuse to overwrite — every snapshot needs a unique session.
            msgs = list(self._context.get_messages())
            if not msgs:
                return
            if reason == "periodic" and len(msgs) == self._last_uploaded_count:
                return
            s3_key = (
                f"contexts/{self._character_id}/{self._session_id}/voice/{self._seq:04d}.json"
            )
            self._last_uploaded_count = len(msgs)
            upload_context(
                s3_key=s3_key,
                messages=msgs,
                db_row={
                    "character_id": self._character_id,
                    "session_id": self._session_id,
                    "snapshot_type": "voice",
                    "s3_key": s3_key,
                    "message_count": len(msgs),
                    "snapshot_reason": reason,
                },
            )
        finally:
            if reason == "compaction":
                self._seq += 1


def upload_context(
    *,
    s3_key: str,
    messages: List[Dict[str, Any]],
    db_row: Dict[str, Any],
) -> None:
    """Fire-and-forget upload of context messages to S3 + DB upsert.

    Parameters
    ----------
    s3_key:
        Full S3 object key (e.g. ``contexts/{char}/{session}/tasks/{task}.json``).
    messages:
        Raw LLM context messages list — serialised as-is to JSON.
    db_row:
        Column values for the ``context_snapshots`` upsert. Must include at
        least ``character_id``, ``session_id``, ``snapshot_type``,
        ``s3_key``, ``message_count``, ``snapshot_reason``.
    """
    cekura_append_context_dump(messages)

    config = _get_config()
    if config is None:
        return
    # Snapshot everything needed for the thread — avoid referencing mutable state later.
    payload_bytes = json.dumps(messages, ensure_ascii=False, default=str).encode("utf-8")
    thread = threading.Thread(
        target=_upload_thread,
        args=(config, s3_key, payload_bytes, db_row),
        daemon=True,
    )
    thread.start()


def _upload_thread(
    config: Dict[str, str],
    s3_key: str,
    payload_bytes: bytes,
    db_row: Dict[str, Any],
) -> None:
    try:
        _upload_to_s3(config, s3_key, payload_bytes)
        logger.debug(f"context_upload: uploaded s3://{config['bucket']}/{s3_key}")
    except Exception as exc:
        logger.error(f"context_upload: S3 upload failed for {s3_key}: {exc}")
        return  # Skip DB upsert if S3 failed

    try:
        _upsert_db_row(config, db_row)
    except Exception as exc:
        logger.error(f"context_upload: DB upsert failed for {s3_key}: {exc}")


def _upload_to_s3(config: Dict[str, str], s3_key: str, payload_bytes: bytes) -> None:
    import io

    import boto3

    client = boto3.client(
        "s3",
        region_name=config["aws_region"],
        aws_access_key_id=config["aws_access_key_id"],
        aws_secret_access_key=config["aws_secret_access_key"],
    )
    client.upload_fileobj(
        io.BytesIO(payload_bytes),
        config["bucket"],
        s3_key,
        ExtraArgs={"ContentType": "application/json"},
    )


def _upsert_db_row(config: Dict[str, str], db_row: Dict[str, Any]) -> None:
    rest_url = config.get("supabase_rest_url", "")
    service_key = config.get("supabase_service_key", "")
    if not rest_url or not service_key:
        return

    import httpx

    now_iso = datetime.now(timezone.utc).isoformat()
    row = {**db_row, "updated_at": now_iso}
    row.setdefault("created_at", now_iso)

    # Determine upsert conflict target based on snapshot type.
    # - task snapshots: unique on (session_id, task_id)
    # - voice snapshots: unique on (s3_key)
    if row.get("task_id"):
        on_conflict = "session_id,task_id"
    else:
        on_conflict = "s3_key"

    url = f"{rest_url}/context_snapshots"
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    params = {"on_conflict": on_conflict}

    with httpx.Client(timeout=10.0) as client:
        resp = client.post(url, headers=headers, params=params, json=row)
        resp.raise_for_status()


async def download_task_context(
    task_id: str,
    character_id: str,
) -> List[Dict[str, Any]]:
    """Download a task's LLM context from S3.

    Looks up the ``context_snapshots`` table for the given task_id,
    verifies it belongs to the requesting character, then fetches the
    JSON from S3.

    Raises
    ------
    ContextNotFoundError
        If no snapshot exists or the character_id doesn't match.
    RuntimeError
        If CONTEXT_S3_BUCKET is not configured.
    """
    config = _get_config()
    if config is None:
        raise RuntimeError("CONTEXT_S3_BUCKET is not configured")

    import asyncio

    # DB lookup and S3 download are blocking — run in a thread.
    return await asyncio.to_thread(_download_task_context_sync, config, task_id, character_id)


def _download_task_context_sync(
    config: Dict[str, str],
    task_id: str,
    character_id: str,
) -> List[Dict[str, Any]]:
    import httpx

    rest_url = config.get("supabase_rest_url", "")
    service_key = config.get("supabase_service_key", "")
    if not rest_url or not service_key:
        raise ContextNotFoundError("Database not configured")

    # Look up the s3_key for this task, scoped to the requesting character.
    url = f"{rest_url}/context_snapshots"
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Accept": "application/json",
    }
    params = {
        "task_id": f"eq.{task_id}",
        "character_id": f"eq.{character_id}",
        "select": "s3_key",
        "limit": "1",
    }
    with httpx.Client(timeout=10.0) as client:
        resp = client.get(url, headers=headers, params=params)
        resp.raise_for_status()
        rows = resp.json()

    if not rows:
        raise ContextNotFoundError(f"No context snapshot found for task {task_id}")

    s3_key = rows[0]["s3_key"]

    # Download from S3.
    import boto3

    s3 = boto3.client(
        "s3",
        region_name=config["aws_region"],
        aws_access_key_id=config["aws_access_key_id"],
        aws_secret_access_key=config["aws_secret_access_key"],
    )
    try:
        obj = s3.get_object(Bucket=config["bucket"], Key=s3_key)
        body = obj["Body"].read()
    except s3.exceptions.NoSuchKey:
        raise ContextNotFoundError(f"S3 object not found: {s3_key}")

    return json.loads(body)
