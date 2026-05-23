"""Per-session character authentication.

Holds the character ID, access token, and display name for one bot session.
The bot constructs it from the RTVI start payload (with env-var fallbacks
for local dev), calls ``authenticate()``, and then hands the populated
object to the rest of the runtime.

Consolidates what used to be split across:
  - ``utils/access_token.py`` (JWT preflight)
  - ``pipecat_server/bot.py`` (`_resolve_character_identity`, the env-fallback
    and display-name lookup)
"""

from __future__ import annotations

import base64
import json
import time

from loguru import logger

from gradientbang.config import settings
from gradientbang.game.client import AsyncGameClient


class AuthError(RuntimeError):
    """Raised when authentication cannot be completed for the current session.

    Subclasses ``RuntimeError`` so callers that catch ``RuntimeError`` still
    work, but callers that want to exit cleanly on expected auth failures
    (vs. propagate unexpected bugs) can catch this type specifically.
    """


class Auth:
    """Per-session character credentials.

    Usage:
        auth = Auth(character_id="...", access_token="...")
        await auth.authenticate()
        # auth.character_id, auth.access_token, auth.display_name are populated

    In production, the bot's /start endpoint receives these values in the
    request body (posted by the login proxy edge function) — pull them out
    of runner_args.body and pass them through. In local dev there's no body,
    so leave them None; authenticate() falls back to the BOT_TEST_* env vars.
    """

    def __init__(
        self,
        *,
        character_id: str | None = None,
        access_token: str | None = None,
        character_name_hint: str | None = None,
    ):
        self.character_id: str | None = character_id
        self.access_token: str | None = access_token
        self.display_name: str | None = None
        self._character_name_hint = character_name_hint
        self._authenticated = False

    def __repr__(self) -> str:
        # SECURITY: never include the raw access_token here. This redaction
        # is the only place the token gets formatted for log output; every
        # log line in this module that mentions `self` goes through __repr__.
        token_repr = "<set>" if self.access_token else "<none>"
        return (
            f"Auth(character_id={self.character_id!r}, "
            f"display_name={self.display_name!r}, access_token={token_repr})"
        )

    async def authenticate(self) -> None:
        """Resolve identity from env, validate the JWT, and look up display name.

        After a successful call:
          - ``self.character_id`` is set
          - ``self.access_token`` is set (or ``None`` if USE_EDGE_TOKEN_FOR_AUTH)
          - ``self.display_name`` is set

        Raises:
            AuthError: if character_id is missing, access_token is missing
                when required, the JWT preflight fails, or the display-name
                lookup fails. Callers should catch this for clean session
                bailout; other exceptions are unexpected bugs and should
                propagate.
        """
        self._resolve_character_id()
        self._resolve_access_token()
        await self._resolve_display_name()
        self._authenticated = True
        logger.info(f"Authenticated: {self!r}")

    # ── internals ────────────────────────────────────────────────────────

    def _resolve_character_id(self) -> None:
        if not self.character_id:
            self.character_id = (
                settings.BOT_TEST_CHARACTER_ID or settings.BOT_TEST_NPC_CHARACTER_NAME
            )
        if not self.character_id:
            raise AuthError(
                "character_id is required. Set BOT_TEST_CHARACTER_ID in the "
                "environment, or pass it via the RTVI start payload."
            )

    def _resolve_access_token(self) -> None:
        # Edge-token auth (e.g. Cekura eval runs) bypasses the per-character JWT.
        if settings.USE_EDGE_TOKEN_FOR_AUTH:
            logger.info("Auth method: edge token (X-Edge-Auth via EDGE_API_TOKEN)")
            self.access_token = None
            return

        source = "start payload"
        if not self.access_token:
            self.access_token = settings.BOT_TEST_ACCESS_TOKEN
            source = "BOT_TEST_ACCESS_TOKEN env"
        if not self.access_token:
            raise AuthError("access_token is required to start a bot session.")
        logger.info(f"Auth method: per-character JWT (source: {source})")
        self._assert_access_token_valid(self.access_token)

    async def _resolve_display_name(self) -> None:
        self.display_name = (
            self._character_name_hint
            or settings.BOT_TEST_CHARACTER_NAME
            or settings.BOT_TEST_NPC_CHARACTER_NAME
        )
        if self.display_name:
            return
        # No hint or env override — look up via the authenticated API.
        # Throwaway client: enable_event_polling=False skips pubsub session,
        # heartbeat, and event adapter — it's just an httpx wrapper for one RPC.
        # Mirrors `_lookup_character_display_name` from the legacy bot.py.
        try:
            async with AsyncGameClient(
                character_id=self.character_id,
                access_token=self.access_token,
                enable_event_polling=False,
            ) as client:
                result = await client.character_info(character_id=self.character_id)
        except Exception as exc:
            raise AuthError(
                f"character_info lookup failed for {self.character_id}: {exc}"
            ) from exc

        name = result.get("name") if isinstance(result, dict) else None
        if not name:
            raise AuthError(
                f"character_info returned no name for {self.character_id} "
                "(token may be invalid or character may not exist)"
            )
        self.display_name = name

    @staticmethod
    def _assert_access_token_valid(access_token: str) -> None:
        """Raise if the Supabase JWT is structurally bad or expired.

        Folded in from ``utils/access_token.py``. We can't verify the
        signature client-side without the issuer's public key, but the
        preflight catches malformed/expired tokens before they hang an
        edge function for 10s.
        """
        parts = access_token.split(".")
        if len(parts) != 3:
            raise AuthError(
                f"access_token is not a JWT (expected 3 segments, got {len(parts)}). "
                "Refresh BOT_TEST_ACCESS_TOKEN via the login edge function."
            )
        try:
            header_b64 = parts[0] + "=" * (-len(parts[0]) % 4)
            json.loads(base64.urlsafe_b64decode(header_b64))
            payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
            claims = json.loads(base64.urlsafe_b64decode(payload_b64))
        except (ValueError, json.JSONDecodeError) as exc:
            raise AuthError(f"access_token is unparseable: {exc}") from exc
        exp = claims.get("exp")
        if not isinstance(exp, (int, float)):
            raise AuthError("access_token has no numeric exp claim")
        if exp <= time.time():
            raise AuthError(
                f"access_token expired at {exp} (now {int(time.time())}). "
                "Refresh BOT_TEST_ACCESS_TOKEN via the login edge function."
            )
