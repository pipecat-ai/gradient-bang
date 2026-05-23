"""Per-session config + state for the bot.

Two paired containers:

- `BotRuntimeConfig` — frozen inputs from the /start request body
  (voice, personality tone, etc.). Captured once and never mutated.
- `BotRuntimeState` — mutable state shared across pipeline components
  during the session (active voice, user-mute flag + waitable event).

Both are constructed once per session in `bot.py` and passed by reference
into consumers (Orchestrator, ClientMessageHandler, etc.).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from pipecat.transcriptions.language import Language


# ── Frozen config: what the /start body asked for ────────────────────────


@dataclass(frozen=True)
class BotRuntimeConfig:
    voice_name: str | None
    voice_id_hint: str | None
    personality_tone: str

    @classmethod
    def from_body(cls, body: dict) -> "BotRuntimeConfig":
        def _opt_str(key: str) -> str | None:
            """Coerce body[key] to a clean non-empty string, or None.

            Defends against missing keys, explicit None values, non-string
            types, and empty/whitespace-only strings — all collapse to None.
            """
            v = body.get(key)
            if not isinstance(v, str):
                return None
            v = v.strip()
            return v or None

        return cls(
            voice_name=_opt_str("voice"),
            voice_id_hint=_opt_str("voice_id"),
            personality_tone=_opt_str("personality_tone") or "",
        )


# ── Mutable state: what's happening right now ────────────────────────────


@dataclass
class BotRuntimeState:
    # ── Active voice (can change mid-session via set-voice RPC) ──────────
    active_voice_name: str
    active_voice_language: Language
    active_tts_provider: str

    # ── User-input mute state ────────────────────────────────────────────
    # `user_muted` is the synchronous flag; `user_unmuted` is an asyncio
    # Event for components that want to await the unmute transition.
    # Seeded to muted because TextInputBypassFirstBotMuteStrategy starts
    # muted and only unmutes after the first bot speech completes.
    user_muted: bool = True
    user_unmuted: asyncio.Event = field(default_factory=asyncio.Event)

    def mark_user_muted(self) -> None:
        self.user_muted = True
        self.user_unmuted.clear()

    def mark_user_unmuted(self) -> None:
        self.user_muted = False
        self.user_unmuted.set()
