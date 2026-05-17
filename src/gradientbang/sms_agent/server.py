"""FastAPI/Twilio webhook for the SMS agent POC."""

from __future__ import annotations

import os

import uvicorn
from fastapi import FastAPI, Form, HTTPException
from fastapi.responses import Response
from loguru import logger
from twilio.twiml.messaging_response import MessagingResponse

from gradientbang.sms_agent.agent import run_turn_response, select_tool

app = FastAPI(title="Gradient Bang SMS Agent")

def _normalized(text: str | None) -> str:
    return " ".join((text or "").strip().lower().split())


def _tool_choice(*values: str | None) -> str | None:
    for value in values:
        tool_name = select_tool(_normalized(value))
        if tool_name:
            return tool_name
    return None


def _twiml_response(message: str | None = None, media_url: str | None = None) -> Response:
    twiml = MessagingResponse()
    if message or media_url:
        outbound = twiml.message(message or "")
        if media_url:
            outbound.media(media_url)
    return Response(content=str(twiml), media_type="text/xml")


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "status": "ok",
        "character_configured": bool(os.getenv("SMS_AGENT_CHARACTER_ID")),
    }


@app.post("/whatsapp")
async def whatsapp(
    Body: str = Form(default=""),
    From: str = Form(default=""),
    To: str = Form(default=""),
    MessageSid: str = Form(default=""),
    ButtonText: str = Form(default=""),
    ButtonPayload: str = Form(default=""),
) -> Response:
    character_id = os.getenv("SMS_AGENT_CHARACTER_ID", "").strip()
    if not character_id:
        raise HTTPException(status_code=500, detail="SMS_AGENT_CHARACTER_ID is not set")

    logger.info(
        "sms_agent.webhook inbound from={} sid={} body={!r} button_text={!r} button_payload={!r}",
        From,
        MessageSid,
        Body,
        ButtonText,
        ButtonPayload,
    )

    user_message = _tool_choice(Body, ButtonText, ButtonPayload) or Body

    try:
        reply = await run_turn_response(
            user_message,
            character_id,
            access_token=os.getenv("SMS_AGENT_ACCESS_TOKEN") or None,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("sms_agent.webhook failed")
        return _twiml_response(f"Sorry, I could not check your Gradient Bang status right now: {exc}")

    return _twiml_response(reply.text, media_url=reply.media_url)


def main() -> None:
    host = os.getenv("SMS_AGENT_HOST", "0.0.0.0")
    port = int(os.getenv("SMS_AGENT_PORT", "8008"))
    uvicorn.run("gradientbang.sms_agent.server:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    main()
