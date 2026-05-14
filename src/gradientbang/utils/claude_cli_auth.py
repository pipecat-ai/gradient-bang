"""Read Claude Code CLI OAuth credentials for Anthropic API authentication.

When Claude Code is installed and signed in, an OAuth token is stored in the
OS credential store. This module reads that token so the bot can authenticate
with the Anthropic API using the developer's existing Claude subscription
instead of a separate API key.

Protocol:
  1. Read the token from macOS Keychain (or ~/.claude/.credentials.json)
  2. Pass it as ``auth_token`` (Bearer), **not** ``api_key``
  3. Include the required beta header ``anthropic-beta: oauth-2025-04-20``

Limitations:
  - Local dev only — Docker/CI/prod must use ANTHROPIC_API_KEY.
  - Tokens expire (~5 hours). Developer must run ``claude`` to refresh.
  - **IMPORTANT**: As of mid-March 2026, the OAuth beta restricts inference 
    to Haiku-tier models only. Sonnet and Opus return 400. 
    This was not the case when initially implemented (2026-03-09). 
    Use ANTHROPIC_API_KEY for full access to Claude models.

Reference: Siftly lib/claude-cli-auth.ts

"""

from __future__ import annotations

import json
import os
import platform
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from loguru import logger

OAUTH_BETA_HEADER = "oauth-2025-04-20"


@dataclass
class ClaudeOAuthCredentials:
    access_token: str
    refresh_token: str
    expires_at: int  # Unix timestamp in milliseconds
    subscription_type: str


def _parse_credentials(raw: str) -> Optional[ClaudeOAuthCredentials]:
    try:
        parsed = json.loads(raw)
        oauth = parsed.get("claudeAiOauth", {})
        if not oauth.get("accessToken"):
            return None
        return ClaudeOAuthCredentials(
            access_token=oauth["accessToken"],
            refresh_token=oauth.get("refreshToken", ""),
            expires_at=oauth.get("expiresAt", 0),
            subscription_type=oauth.get("subscriptionType", ""),
        )
    except (json.JSONDecodeError, KeyError):
        return None


def _read_mac_credentials() -> Optional[ClaudeOAuthCredentials]:
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return None
        return _parse_credentials(result.stdout.strip())
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None


def _read_file_credentials() -> Optional[ClaudeOAuthCredentials]:
    cred_path = Path.home() / ".claude" / ".credentials.json"
    try:
        raw = cred_path.read_text(encoding="utf-8")
        return _parse_credentials(raw)
    except (FileNotFoundError, PermissionError):
        return None


# Module-level cache (60s TTL to avoid repeated keychain lookups ~50-200ms each)
_cached_credentials: Optional[ClaudeOAuthCredentials] = None
_cache_read_at: float = 0
_CACHE_TTL_SECONDS = 60


def read_cli_credentials() -> Optional[ClaudeOAuthCredentials]:
    """Read Claude Code CLI credentials from the OS credential store.

    Results are cached for 60 seconds.
    """
    global _cached_credentials, _cache_read_at
    now = time.time()

    if _cached_credentials and (now - _cache_read_at) < _CACHE_TTL_SECONDS:
        if now * 1000 <= _cached_credentials.expires_at:
            return _cached_credentials

    if platform.system() == "Darwin":
        creds = _read_mac_credentials()
    else:
        creds = _read_file_credentials()

    _cached_credentials = creds
    _cache_read_at = now
    return creds


def create_async_anthropic_client():
    """Create an AsyncAnthropic client using Claude CLI OAuth.

    Returns None if CLI auth is not available or the token is expired.
    The returned client uses ``auth_token`` (Bearer) with the required
    ``anthropic-beta: oauth-2025-04-20`` header.
    """
    from anthropic import AsyncAnthropic

    creds = read_cli_credentials()
    if not creds:
        return None

    if time.time() * 1000 > creds.expires_at:
        logger.warning("Claude CLI OAuth token expired — run `claude` to refresh")
        return None

    logger.info(
        f"Using Claude CLI OAuth (subscription: {creds.subscription_type}) "
        f"instead of ANTHROPIC_API_KEY"
    )

    # The SDK falls back to os.environ["ANTHROPIC_API_KEY"] when api_key=None.
    # If that env var is "" (empty), it poisons auth_headers with an empty
    # X-Api-Key, shadowing the auth_token Bearer header. Temporarily remove
    # the env var so the SDK doesn't pick it up.
    stashed = os.environ.pop("ANTHROPIC_API_KEY", None)
    try:
        client = AsyncAnthropic(auth_token=creds.access_token)
    finally:
        if stashed is not None:
            os.environ["ANTHROPIC_API_KEY"] = stashed

    return client
