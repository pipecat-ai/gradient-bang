"""Bot-driven TUI application that mirrors the player UI but
receives updates from a running Pipecat bot via LocalMacTransport.

- Uses the same panels as the existing player_app.
- Starts the bot module with LocalMacTransport on mount (handled by BotTUIBase).
- Handles RTVI server messages (gg-action/ ui-action) and updates panels.
- Ctrl+L toggles a syslog panel (replacing prior clear-output binding).
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.widgets import Header, Footer

from voice_tui_kit.core.base_app import BotTUIBase
from tui.widgets.chat_widget import ChatWidget
from tui.widgets.task_output_widget import TaskOutputWidget
from tui.widgets.map_widget import MapWidget
from tui.widgets.history_widgets import MovementHistoryWidget, PortHistoryWidget
from tui.widgets.progress_widget import ProgressWidget
from tui.widgets.debug_widget import DebugWidget
from tui.widgets.status_bar_widget import StatusBarWidget
from voice_tui_kit.widgets.syslog_panel import SyslogPanel
from voice_tui_kit.core.utils.json_render import compact_json
from voice_tui_kit.widgets.rtvi_list_panel import RTVIListPanel


class BotPlayerApp(BotTUIBase):
    """TUI app that renders the Player UI and syncs via RTVI messages."""

    # Extend base bindings with mute toggle on F2
    BINDINGS = BotTUIBase.BINDINGS + [
        ("f2", "toggle_mute", "Mute / Unmute"),
    ]

    CSS = """
    #status-bar {
        height: 3;
        border: solid white;
        padding: 0 1;
        background: $boost;
    }

    #chat-container {
        height: 2fr;
        border: solid cyan;
        padding: 1;
    }

    #task-output {
        height: 1fr;
        border: solid green;
        padding: 1;
    }

    #map-widget {
        width: 100%;
        height: 40%;
        border: solid magenta;
        padding: 1;
    }

    #map-scroll { height: 100%; }
    #progress-scroll { height: 100%; }

    #progress-widget {
        height: 6;
        border: solid yellow;
        padding: 1;
    }

    #movement-history { height: 1fr; border: solid blue; padding: 1; }
    #port-history { height: 1fr; border: solid red; padding: 1; }
    #debug-widget { border: solid white; padding: 1; height: 100%; }

    #left-panel { width: 60%; }
    #right-panel { width: 40%; }

    /* Base overlays */
    #rtvi_panes { layout: horizontal; height: 1fr; }
    #rtvi_panes > Vertical { height: 1fr; }
    .log { border: round $primary; height: 1fr; }
    """

    def __init__(self, bot_module) -> None:  # type: ignore[no-untyped-def]
        super().__init__(bot_module)
        self.current_sector: int = 0
        self._agent_text_buf: list[str] = []
        self._client_text_buf: str = ""
        self._map_data: Dict[str, Any] = {}
        self._muted: bool = False
        self._mute_counter: int = 0
        self._pending_mute: Optional[bool] = None

        # Widgets (set on mount)
        self.status_bar: Optional[StatusBarWidget] = None
        self.chat_widget: Optional[ChatWidget] = None
        self.task_output: Optional[TaskOutputWidget] = None
        self.map_widget: Optional[MapWidget] = None
        self.progress_widget: Optional[ProgressWidget] = None
        self.movement_history: Optional[MovementHistoryWidget] = None
        self.port_history: Optional[PortHistoryWidget] = None
        self.debug_widget: Optional[DebugWidget] = None

        # Overlays required by BotTUIBase
        self.syslog: Optional[SyslogPanel] = None
        self.rtvi_inbox: Optional[RTVIListPanel] = None
        self.rtvi_outbox: Optional[RTVIListPanel] = None

    def compose(self) -> ComposeResult:  # type: ignore[override]
        yield Header(show_clock=True)
        # Top status bar
        self.status_bar = StatusBarWidget(id="status-bar")
        yield self.status_bar

        # Main split view
        with Horizontal():
            with Vertical(id="left-panel"):
                self.chat_widget = ChatWidget(id="chat-widget")
                yield self.chat_widget
                self.task_output = TaskOutputWidget(id="task-output")
                yield self.task_output

            with Vertical(id="right-panel"):
                self.map_widget = MapWidget(id="map-widget")
                yield self.map_widget
                self.progress_widget = ProgressWidget(id="progress-widget")
                yield self.progress_widget
                self.movement_history = MovementHistoryWidget(id="movement-history")
                yield self.movement_history
                self.port_history = PortHistoryWidget(id="port-history")
                yield self.port_history
                self.debug_widget = DebugWidget(id="debug-widget")
                yield self.debug_widget

        # RTVI overlay panes and syslog panel (managed by base)
        with Horizontal(id="rtvi_panes"):
            self.rtvi_inbox = RTVIListPanel(id="inbox", classes="log")
            self.rtvi_outbox = RTVIListPanel(id="outbox", classes="log")
            yield self.rtvi_inbox
            yield self.rtvi_outbox

        self.syslog = SyslogPanel(id="syslog", classes="log")
        self.syslog.display = False
        yield self.syslog

        yield Footer()

    async def on_mount(self) -> None:  # type: ignore[override]
        # Hide advanced panels initially; no debug chat until requested
        assert self.debug_widget is not None
        assert self.map_widget is not None
        assert self.progress_widget is not None
        assert self.movement_history is not None
        assert self.port_history is not None

        self.map_widget.styles.display = "block"
        self.progress_widget.styles.display = "block"
        self.movement_history.styles.display = "block"
        self.port_history.styles.display = "block"
        self.debug_widget.styles.display = "none"

        # Disable direct text input for now
        if self.chat_widget is not None:
            try:
                self.chat_widget.set_input_enabled(False)
            except Exception:
                pass

        # Start transport + bot via base class
        await super().on_mount()

    async def action_toggle_mute(self) -> None:  # type: ignore[override]
        """Toggle microphone capture via RTVI client-message."""
        self._muted = not self._muted
        self._mute_counter += 1
        # If transport isn't connected yet, defer sending
        if not getattr(self, "_transport_connected", False):
            self._pending_mute = self._muted
            if self.syslog:
                self.syslog.write_line(
                    f"[info] Queued {'mute' if self._muted else 'unmute'} until transport is connected"
                )
            if self.chat_widget:
                self.chat_widget.add_message(
                    "system", f"Audio {'muted' if self._muted else 'unmuted'} (queued)"
                )
            return
        payload = {
            "label": "rtvi-ai",
            "type": "client-message",
            "id": f"mute-{self._mute_counter}",
            "data": {"t": "mute-unmute", "d": {"mute": self._muted}},
        }
        try:
            await self.transport_mgr.send_app_message(payload)
            if self.syslog:
                self.syslog.write_line(
                    f"[info] {'Muted' if self._muted else 'Unmuted'} (sent client-message)"
                )
            if self.chat_widget:
                self.chat_widget.add_message(
                    "system", f"Audio {'muted' if self._muted else 'unmuted'}"
                )
        except Exception as e:
            if self.syslog:
                self.syslog.write_line(f"[error] Failed to send mute toggle: {e}")
            # Keep it queued to retry on connect
            self._pending_mute = self._muted

    async def _on_status(self, connected: bool) -> None:  # type: ignore[override]
        await super()._on_status(connected)
        # On connect, flush any queued mute state
        if connected and self._pending_mute is not None:
            try:
                self._mute_counter += 1
                payload = {
                    "label": "rtvi-ai",
                    "type": "client-message",
                    "id": f"mute-{self._mute_counter}",
                    "data": {"t": "mute-unmute", "d": {"mute": self._pending_mute}},
                }
                await self.transport_mgr.send_app_message(payload)
                self._muted = bool(self._pending_mute)
                if self.syslog:
                    self.syslog.write_line(
                        f"[info] {'Muted' if self._muted else 'Unmuted'} (sent on connect)"
                    )
            except Exception as e:
                if self.syslog:
                    self.syslog.write_line(f"[error] Failed to send queued mute: {e}")
            finally:
                self._pending_mute = None

    # Utility to show a specific panel and hide others on the right side
    def show_panel(self, panel: str) -> None:
        """Respond to ui-action show_panel without hiding core panels.

        - If panel == 'debug', show debug and hide map/progress/history/ports.
        - Otherwise, ensure core panels are visible and debug is hidden.
        """
        if self.syslog:
            self.syslog.write_line(f"[rtvi] show_panel requested: {panel}")

        # Ensure we have widgets
        if not (
            self.map_widget and self.progress_widget and self.movement_history and self.port_history and self.debug_widget
        ):
            return

        if panel == "debug":
            self.map_widget.styles.display = "none"
            self.progress_widget.styles.display = "none"
            self.movement_history.styles.display = "none"
            self.port_history.styles.display = "none"
            self.debug_widget.styles.display = "block"
        else:
            # Keep core panels visible during tasks/moves
            self.map_widget.styles.display = "block"
            self.progress_widget.styles.display = "block"
            self.movement_history.styles.display = "block"
            self.port_history.styles.display = "block"
            self.debug_widget.styles.display = "none"

    # Map RTVI server messages to UI updates
    async def _on_inbound(self, payload: Any) -> None:  # type: ignore[override]
        await super()._on_inbound(payload)
        try:
            if isinstance(payload, dict):
                # UI actions
                if "ui-action" in payload and payload.get("ui-action") == "show_panel":
                    panel = str(payload.get("panel", ""))
                    if panel:
                        self.show_panel(panel)
                        if self.syslog:
                            self.syslog.write_line(f"[rtvi] ui-action=show_panel panel={panel}")
                    return

                action = payload.get("gg-action")
                if not action:
                    return

                if action in ("status.init", "status.update", "init", "my_status"):
                    result = payload.get("result", {})
                    map_data = payload.get("map_data")
                    self._update_status(result)
                    if map_data:
                        self._update_map(map_data)
                    # Also broadcast a concise system message to chat and seed movement/history
                    try:
                        ship = (result or {}).get("ship", {}) if isinstance(result, dict) else {}
                        sector = int((result or {}).get("sector", self.current_sector) or 0)
                        name = ship.get("ship_name") or ship.get("ship_type") or "Ship"
                        wp = ship.get("warp_power")
                        wpc = ship.get("warp_power_capacity")
                        credits = ship.get("credits")
                        summary_bits = [f"Sector {sector}"]
                        if wp is not None and wpc is not None:
                            summary_bits.append(f"Warp {wp}/{wpc}")
                        if credits is not None:
                            summary_bits.append(f"Credits {credits}")
                        if self.chat_widget:
                            self.chat_widget.add_message(
                                "system",
                                f"Connected: {name}. " + ", ".join(summary_bits),
                            )
                        # Seed movement panel with current sector context (optional, no-op if zero)
                        if self.movement_history and sector:
                            try:
                                # Extract port code if available in map_data/status
                                port_code = ""
                                if isinstance(result, dict):
                                    contents = result.get("sector_contents") or {}
                                    if isinstance(contents, dict):
                                        port = contents.get("port") or {}
                                        if isinstance(port, dict):
                                            port_code = str(port.get("code") or "")
                                self.movement_history.add_movement(sector, sector, port_code)
                            except Exception:
                                pass
                    except Exception:
                        pass
                    if self.syslog:
                        self.syslog.write_line(f"[rtvi] action={action} -> status/map updated")
                elif action == "move":
                    result = payload.get("result", {})
                    self._handle_move(result)
                    if self.syslog:
                        self.syslog.write_line("[rtvi] action=move -> movement handled")
                elif action == "my_map":
                    self._update_map(payload.get("result", {}))
                    if self.syslog:
                        self.syslog.write_line("[rtvi] action=my_map -> map updated")
                elif action == "recharge_warp_power":
                    res = payload.get("result", {})
                    # Normalize to status-like shape for the status bar
                    status_like = {
                        "ship": {
                            "warp_power": res.get("new_warp_power", 0),
                            "warp_power_capacity": res.get("warp_power_capacity", 0),
                            "credits": res.get("new_credits", 0),
                        }
                    }
                    self._update_status(status_like)
                    if self.syslog:
                        self.syslog.write_line("[rtvi] action=recharge_warp_power -> status updated")
                elif action == "task_output":
                    txt = str(payload.get("text", ""))
                    if txt and self.task_output:
                        self.task_output.add_info(txt)
                        if self.syslog:
                            self.syslog.write_line("[rtvi] action=task_output -> appended")
                elif action in ("start_task", "stop_task", "task_complete"):
                    if self.progress_widget:
                        if action == "start_task":
                            desc = str(payload.get("task_description", "Task"))
                            self.progress_widget.start_task(desc or "Task")
                        elif action == "stop_task":
                            self.progress_widget.stop_task("Task cancelled")
                        else:  # task_complete
                            self.progress_widget.stop_task("Task complete")
                        if self.syslog:
                            self.syslog.write_line(f"[rtvi] action={action} -> progress updated")
                elif action in ("tool_result", "tool_call"):
                    # Tool call/result envelope from VoiceTaskManager
                    tool = str(payload.get("tool_name", ""))
                    pl = payload.get("payload", {})
                    # Treat successful results like direct actions for UI updates.
                    # Payload shapes observed:
                    #  a) {"result": {...}}
                    #  b) {"role":"tool", "content":"{...json...}"}
                    result_obj = None
                    if isinstance(pl, dict):
                        if "result" in pl:
                            result_obj = pl.get("result")
                        elif isinstance(pl.get("content"), str):
                            # Try to parse content as JSON
                            import json
                            try:
                                result_obj = json.loads(pl.get("content", ""))
                            except Exception:
                                result_obj = None
                    if action == "tool_result" and result_obj is not None:
                        if tool == "my_status":
                            self._update_status(result_obj or {})
                        elif tool == "my_map":
                            self._update_map(result_obj or {})
                        elif tool == "move":
                            self._handle_move(result_obj or {})
                        elif tool == "recharge_warp_power":
                            rr = result_obj or {}
                            status_like = {
                                "ship": {
                                    "warp_power": rr.get("new_warp_power", 0),
                                    "warp_power_capacity": rr.get("warp_power_capacity", 0),
                                    "credits": rr.get("new_credits", 0),
                                }
                            }
                            self._update_status(status_like)
                        elif tool == "trade":
                            if self.status_bar:
                                self.status_bar.update_from_trade(result_obj or {})
                        else:
                            # Generic: if result carries sector/map-like data, update accordingly
                            try:
                                if isinstance(result_obj, dict):
                                    if "sector" in result_obj:
                                        self._handle_move(result_obj)
                                    elif "sectors_visited" in result_obj:
                                        self._update_map(result_obj)
                            except Exception:
                                pass
                        if self.syslog:
                            got = list(result_obj.keys()) if isinstance(result_obj, dict) else type(result_obj).__name__
                            self.syslog.write_line(f"[rtvi] {action} tool={tool} -> handled result keys={got}")
                    # Optionally reflect tool call in progress panel
                    if action == "tool_call" and self.progress_widget:
                        if tool:
                            self.progress_widget.update_action(f"Calling tool: {tool}")
                            if self.syslog:
                                self.syslog.write_line(f"[rtvi] tool_call {tool}")
        except Exception as e:
            if self.syslog:
                self.syslog.write_line(f"[error] inbound handler failed: {e}")

    async def _on_outbound(self, payload: Any) -> None:  # type: ignore[override]
        # Keep debug list updated
        await super()._on_outbound(payload)

        # Heuristic mapping of transport frames to conversation entries and server messages
        try:
            if self.syslog:
                try:
                    cls = type(payload).__name__
                    t = getattr(payload, "type", None)
                    d = getattr(payload, "data", None)
                    msg = getattr(payload, "message", None)
                    preview = None
                    if isinstance(payload, dict):
                        preview = list(payload.keys())
                    elif isinstance(d, dict):
                        preview = list(d.keys())
                    self.syslog.write_line(
                        f"[rtvi] outbound frame cls={cls} type={t} has_data={isinstance(d, dict)} keys={preview}"
                    )
                except Exception:
                    pass
            name = type(payload).__name__.lower() if hasattr(payload, "__class__") else ""

            # If dict-like with an explicit type
            if isinstance(payload, dict):
                # Debug: compact dump of the frame
                if self.syslog:
                    try:
                        self.syslog.write_line(f"[rtvi] outbound dict: {compact_json(payload)[:300]}")
                    except Exception:
                        pass
                # First, handle server gg-action/ui-action messages (these come through transport)
                if "gg-action" in payload or "ui-action" in payload:
                    # Reuse inbound handling logic for consistency
                    await self._on_inbound(payload)
                    return
                # Some backends wrap data under 'data'
                if "data" in payload and isinstance(payload["data"], dict):
                    d = payload["data"]
                    if "gg-action" in d or "ui-action" in d:
                        await self._on_inbound(d)
                        return
                ptype = str(payload.get("type", "")).lower()
                plabel = str(payload.get("label", "")).lower()
                if ptype in ("user_transcript", "user-transcript", "user_transcription", "user-transcription"):
                    data = payload.get("data", {}) if isinstance(payload, dict) else {}
                    text = str((data or {}).get("text", payload.get("text", "")))
                    final = bool((data or {}).get("final", payload.get("final", False)))
                    self._buffer_user_text(text, final)
                    return
                if ptype in ("bot_tts_text", "bot-tts-text", "llm_text", "llm-text"):
                    data = payload.get("data", {}) if isinstance(payload, dict) else {}
                    text = str((data or {}).get("text", payload.get("text", "")))
                    self._buffer_agent_text(text)
                    return
                if ptype in ("bot_stopped_speaking", "bot-stopped-speaking"):
                    self._flush_agent_text()
                    return
                # Fallbacks when 'type' isn't populated but label indicates the event
                d = payload.get("data", {}) if isinstance(payload, dict) else {}
                text = str((d or {}).get("text", payload.get("text", "")))
                if text:
                    if ("user" in plabel and ("transcript" in plabel or "transcription" in plabel)):
                        final = bool((d or {}).get("final") or (d or {}).get("is_final") or (d or {}).get("final_result"))
                        self._buffer_user_text(text, final)
                        return
                    if ("bot" in plabel and ("tts" in plabel or "llm" in plabel or "assistant" in plabel)):
                        self._buffer_agent_text(text)
                        # We may not know the end marker; let flush happen later
                        return

            # Object-style frames (RTVI message objects)
            text = getattr(payload, "text", None)
            final = getattr(payload, "final", None)

            if "transcription" in name or "transcript" in name:
                if text:
                    self._buffer_user_text(str(text), bool(final))
                return

            if any(t in name for t in ("bot", "tts", "llmtext", "llm_text", "assistant")):
                if text:
                    self._buffer_agent_text(str(text))
                # Some frames may indicate end of utterance by class name
                if "stopped" in name or "end" in name:
                    self._flush_agent_text()
                return

            # Server messages carried as RTVI* objects with `.data`
            data_attr = getattr(payload, "data", None)
            if isinstance(data_attr, dict) and (
                "gg-action" in data_attr or "ui-action" in data_attr
            ):
                await self._on_inbound(data_attr)
                return

            # Fallback: noop
        except Exception as e:
            if self.syslog:
                self.syslog.write_line(f"[warn] outbound handler parse error: {e}")

    def _buffer_user_text(self, text: str, final: bool) -> None:
        if not text:
            return
        # Show interim in chat input area later if desired; for now only final
        if final:
            if self.chat_widget:
                self.chat_widget.add_message("user", text)
            if self.syslog:
                self.syslog.write_line(f"[rtvi] user(final): {text}")
            self._client_text_buf = ""
        else:
            self._client_text_buf = text

    def _buffer_agent_text(self, text: str) -> None:
        if not text:
            return
        self._agent_text_buf.append(text)

    def _flush_agent_text(self) -> None:
        if not self._agent_text_buf:
            return
        text = " ".join(self._agent_text_buf).strip()
        self._agent_text_buf.clear()
        if text and self.chat_widget:
            self.chat_widget.add_message("assistant", text)
        if self.syslog and text:
            self.syslog.write_line(f"[rtvi] agent(finish): {text}")

    def _update_status(self, status: Dict[str, Any], record_movement: bool = True) -> None:
        if self.status_bar:
            self.status_bar.update_from_status(status)
        # Merge any map hints from this status into the local cache
        try:
            self._merge_map_from_status(status)
        except Exception:
            pass
        # Movement history and current sector update when sector present
        if "sector" in status:
            new_sector = int(status["sector"])
            if record_movement:
                self._maybe_record_movement(self.current_sector, new_sector)
            self.current_sector = new_sector or self.current_sector
            # Recenter/refresh local map on sector changes using updated cache
            if self.map_widget:
                try:
                    self.map_widget.update_map(self.current_sector, self._map_data or {})
                    if self.syslog:
                        self.syslog.write_line(f"[rtvi] map recenter -> sector={self.current_sector}")
                except Exception:
                    pass
            if self.port_history:
                try:
                    self.port_history.update_ports(self._map_data or {})
                except Exception:
                    pass

    def _update_map(self, map_data: Dict[str, Any]) -> None:
        # Cache map data so movement can recenter
        self._map_data = map_data or {}
        if self.map_widget:
            self.map_widget.update_map(self.current_sector, self._map_data)
        if self.port_history:
            self.port_history.update_ports(self._map_data)

    def _handle_move(self, status: Dict[str, Any]) -> None:
        # Move includes a status-like dict
        new_sector = int(status.get("sector", self.current_sector))
        self._maybe_record_movement(self.current_sector, new_sector)
        # We've recorded movement already; update status without re-recording
        self._update_status(status, record_movement=False)

    def _maybe_record_movement(self, from_sector: int, to_sector: int) -> None:
        if (
            self.movement_history is None
            or to_sector == 0
            or from_sector == 0
            or to_sector == from_sector
        ):
            return
        self.movement_history.add_movement(from_sector, to_sector, "")

    def _merge_map_from_status(self, status: Dict[str, Any]) -> None:
        """Merge minimal map knowledge from a status payload into cache.

        Recognizes keys:
        - `sector`: current sector id
        - `adjacent_sectors`: list[int]
        - `sector_contents.port` -> stored as `port_info`
        """
        if not isinstance(status, dict):
            return
        sector = int(status.get("sector") or 0)
        if sector <= 0:
            return
        # Ensure cache structure
        if not isinstance(self._map_data, dict):
            self._map_data = {}
        sv = self._map_data.setdefault("sectors_visited", {})
        key = f"sector_{sector}"
        entry = dict(sv.get(key) or {})
        # Sector id for convenience in tables
        entry.setdefault("sector_id", sector)
        # Adjacent sectors from status
        if isinstance(status.get("adjacent_sectors"), (list, tuple)):
            try:
                adj = [int(x) for x in status.get("adjacent_sectors") if int(x) > 0]
                entry["adjacent_sectors"] = sorted(set(adj))
            except Exception:
                pass
        # Port info normalization: sector_contents.port -> port_info
        sc = status.get("sector_contents")
        if isinstance(sc, dict):
            port = sc.get("port") or sc.get("port_info")
            if isinstance(port, dict) and port:
                entry["port_info"] = port
        # Write back and store
        sv[key] = entry
        self._map_data["sectors_visited"] = sv
