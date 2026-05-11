"""Lightweight Supabase Auth JWT preflight.

We can't verify the signature client-side without the issuer's public key, but
we can fail fast on structurally bad or expired tokens before the bot makes
auth-gated RPCs — otherwise a malformed token hangs the edge function for 10s
before httpx times out.
"""

from __future__ import annotations

import base64
import json
import time


def assert_access_token_valid(access_token: str) -> None:
    """Raise if the JWT is malformed or expired.

    Checks the structural shape (3 base64url segments), parses header + payload
    as JSON, and rejects when the `exp` claim is missing, non-numeric, or in
    the past.
    """
    parts = access_token.split(".")
    if len(parts) != 3:
        raise RuntimeError(
            f"access_token is not a JWT (expected 3 segments, got {len(parts)}). "
            "Refresh BOT_TEST_ACCESS_TOKEN via the login edge function."
        )
    try:
        header_b64 = parts[0] + "=" * (-len(parts[0]) % 4)
        json.loads(base64.urlsafe_b64decode(header_b64))
        payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload_b64))
    except (ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"access_token is unparseable: {exc}") from exc
    exp = claims.get("exp")
    if not isinstance(exp, (int, float)):
        raise RuntimeError("access_token has no numeric exp claim")
    if exp <= time.time():
        raise RuntimeError(
            f"access_token expired at {exp} (now {int(time.time())}). "
            "Refresh BOT_TEST_ACCESS_TOKEN via the login edge function."
        )
