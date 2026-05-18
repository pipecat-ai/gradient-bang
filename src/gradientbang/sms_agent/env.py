"""Environment loading for the SMS/WhatsApp agent."""

from __future__ import annotations

from dotenv import load_dotenv


def load_sms_env() -> None:
    """Load shared bot env first, then SMS-specific overrides."""
    load_dotenv(dotenv_path=".env.bot")
    load_dotenv(dotenv_path=".env.sms", override=True)
