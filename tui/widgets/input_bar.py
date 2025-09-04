from __future__ import annotations

import json
from typing import Any, Callable

from textual.widgets import Input


class InputBar(Input):
    """An input bar that emits parsed payloads to a callback.

    The callback signature is: async def on_message(payload: Any) -> None
    """

    def __init__(self, on_submit_callback: Callable[[Any], None | any], **kwargs):  # type: ignore[no-untyped-def]
        super().__init__(**kwargs)
        self._on_submit = on_submit_callback
        self.placeholder = "Type RTVI JSON or text and press Enter"
        self.disabled = True
        self._sent_id = 0

    async def _emit_message(self, text: str) -> None:
        try:
            payload = json.loads(text)
        except Exception:
            payload = {
                "id": "input-" + str(self._sent_id),
                "label": "rtvi-ai",
                "type": "client-message",
                "data": {"t": "llm-input", "d": {"messages": [{"role": "user", "content": text}]}},
                # todo: standard, later
                # "type": "append-to-context",
                # "data": {"role": "user", "content": text, "run_immediately": True},
            }
        self._sent_id += 1
        res = self._on_submit(payload)
        if hasattr(res, "__await__"):
            await res  # type: ignore[misc]

    async def on_submit(self, value: str) -> None:
        await self._emit_message(value)

    async def on_input_submitted(self, event: Input.Submitted) -> None:  # type: ignore[override]
        text = event.value.strip()
        if not text:
            return
        await self._emit_message(text)
        self.value = ""
