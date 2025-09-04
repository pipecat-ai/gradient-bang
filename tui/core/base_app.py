from __future__ import annotations

from typing import Any, Optional

import os
from loguru import logger
from textual.app import App, ComposeResult
from textual.widgets import Header, Footer, Static, ListItem
from textual.containers import Horizontal, Vertical

from tui.core.services.transport_manager import TransportManager
from tui.core.services.bot_runner import BotRunner
from tui.core.utils.clipboard import copy_text

from tui.widgets.syslog_panel import SyslogPanel
from tui.widgets.rtvi_list_panel import RTVIListPanel


class BotTUIBase(App):
    CSS = """
    Screen { layout: vertical; }
    #status { height: 3; border: round $accent; padding: 0 1; }
    #panes { layout: horizontal; height: 1fr; }
    /* RTVI overlay panes */
    #rtvi_panes { layout: horizontal; height: 1fr; }
    #rtvi_panes > Vertical { height: 1fr; }
    .log { border: round $primary; height: 1fr; }
    #input { border: round $secondary; }

    /* Messages panel tweaks: thin border + light padding per item */
    #messages { border: solid $primary; }
    #messages ListItem { padding: 1 1 0 1; }

    #outbox ListItem { padding: 0; }
    #outbox Collapsible { padding-left: 0; padding-bottom: 0; border: none; }
    #outbox CollapsibleTitle { padding: 0 1; height: 1; }
    #outbox ListItem.-highlight CollapsibleTitle {
        background: $block-cursor-background;
        color: $block-cursor-foreground;
        text-style: $block-cursor-text-style;
    }

    #inbox { height: 1fr; }
    #outbox { height: 1fr; }
    #inbox ListItem { padding: 0; }
    #inbox Collapsible { padding-left: 0; padding-bottom: 0; border: none; }
    #inbox CollapsibleTitle { padding: 0 1; height: 1; }
    #inbox ListItem.-highlight CollapsibleTitle {
        background: $block-cursor-background;
        color: $block-cursor-foreground;
        text-style: $block-cursor-text-style;
    }
    """

    BINDINGS = [
        ("ctrl+q", "quit", "Quit"),
        ("ctrl+l", "toggle_log", "Log view"),
        ("ctrl+n", "toggle_rtvi", "RTVI view"),
        ("ctrl+y", "copy_selection", "Copy selected"),
    ]

    def __init__(self, bot_module) -> None:  # type: ignore[no-untyped-def]
        super().__init__()
        self._bot_module = bot_module
        self.transport_mgr = TransportManager()
        self.bot_runner: Optional[BotRunner] = None
        self.status: Optional[Static] = None
        self.syslog: Optional[SyslogPanel] = None
        self.rtvi_inbox: Optional[RTVIListPanel] = None
        self.rtvi_outbox: Optional[RTVIListPanel] = None
        self._mounted_once: bool = False

    def compose(self) -> ComposeResult:  # type: ignore[override]
        yield Header(show_clock=True)
        with Vertical():
            self.status = Static("Status: initializing", id="status")
            yield self.status
            with Horizontal(id="rtvi_panes"):
                self.rtvi_inbox = RTVIListPanel(id="inbox", classes="log")
                self.rtvi_outbox = RTVIListPanel(id="outbox", classes="log")
                yield self.rtvi_inbox
                yield self.rtvi_outbox
            self.syslog = SyslogPanel(id="syslog", classes="log")
            self.syslog.display = False
            yield self.syslog
        yield Footer()

    async def on_mount(self) -> None:
        if self._mounted_once:
            logger.warning("Base on_mount: called more than once; ignoring re-entry")
            return
        self._mounted_once = True

        logger.debug("Base on_mount: starting transport manager")
        await self.transport_mgr.start()
        self.transport_mgr.on_status(self._on_status)
        self.transport_mgr.on_inbound(self._on_inbound)
        self.transport_mgr.on_outbound(self._on_outbound)
        logger.debug("Base on_mount: transport manager started; wiring bot runner")

        assert self.syslog is not None
        if os.getenv("TUI_NO_BOT") == "1":
            logger.warning("Base on_mount: TUI_NO_BOT=1; skipping bot runner start")
        else:
            self.bot_runner = BotRunner(self._bot_module, self.syslog.write_line)
            await self.bot_runner.start(self.transport_mgr.transport)
            logger.debug("Base on_mount: bot runner started")

        # Ensure RTVI panels are wired even if subclass compose created them
        try:
            if not self.rtvi_inbox:
                self.rtvi_inbox = self.query_one("#inbox", RTVIListPanel)  # type: ignore[assignment]
            if not self.rtvi_outbox:
                self.rtvi_outbox = self.query_one("#outbox", RTVIListPanel)  # type: ignore[assignment]
        except Exception:
            pass
        if getattr(self, "_rtvi_titles", False):
            # App supplies its own titles; skip list headers
            pass
        else:
            if self.rtvi_inbox and self.rtvi_outbox:
                await self.rtvi_inbox.append(ListItem(Static("Inbound RTVI:")))
                await self.rtvi_outbox.append(ListItem(Static("Outbound RTVI:")))
            else:
                logger.debug("Base on_mount: RTVI panels not found; skipping headers")

        self.query_one("#rtvi_panes").display = False
        logger.debug("Base on_mount: initial UI state set")

    async def _on_status(self, connected: bool) -> None:
        if self.status:
            self.status.update("Status: connected" if connected else "Status: disconnected")

    async def _on_inbound(self, payload: Any) -> None:
        if self.rtvi_inbox:
            await self.rtvi_inbox.append_json(payload)

    async def _on_outbound(self, payload: Any) -> None:
        if self.rtvi_outbox:
            await self.rtvi_outbox.append_json(payload)

    async def action_toggle_log(self) -> None:
        assert self.syslog is not None
        show_log = not self.syslog.display
        self.syslog.display = show_log
        # Leaving log view should always return to main view; hide RTVI panes
        self.query_one("#rtvi_panes").display = False
        if not show_log:
            self.focus_input()

    async def action_toggle_rtvi(self) -> None:
        rtvi_panes = self.query_one("#rtvi_panes")
        show = not rtvi_panes.display
        rtvi_panes.display = show
        assert self.syslog is not None
        if show:
            self.syslog.display = False
            # Force a layout pass so empty ListViews become visible when shown
            try:
                rtvi_panes.refresh(layout=True)
                if self.rtvi_inbox is not None:
                    self.rtvi_inbox.refresh(layout=True)
                if self.rtvi_outbox is not None:
                    self.rtvi_outbox.refresh(layout=True)
            except Exception:
                pass
        else:
            # Returning from RTVI view goes back to main
            self.focus_input()

    def focus_input(self) -> None:
        try:
            self.set_focus(self.query_one("#input"))
        except Exception:
            pass

    def focus_syslog(self) -> None:
        try:
            if self.syslog is not None:
                self.set_focus(self.syslog)
        except Exception:
            pass

    async def action_copy_selection(self) -> None:
        focused = self.focused
        if focused is not None:
            selection = getattr(focused, "text_selection", None)
            get_sel = getattr(focused, "get_selection", None)
            if selection is not None and callable(get_sel):
                try:
                    res = get_sel(selection)  # type: ignore[misc]
                    if res:
                        text, _ = res
                        if text:
                            if copy_text(text):
                                self.syslog and self.syslog.write_line(
                                    "[info] Copied selection to clipboard"
                                )
                                return
                except Exception:
                    pass

        for panel in (self.rtvi_outbox, self.rtvi_inbox):
            if panel is None:
                continue
            text = panel.copy_current()
            if text:
                if copy_text(text):
                    self.syslog and self.syslog.write_line("[info] Copied item to clipboard")
                    return
        self.syslog and self.syslog.write_line("[warn] Nothing to copy")

    async def action_quit(self) -> None:  # type: ignore[override]
        logger.info("Base action_quit: begin")
        try:
            if self.bot_runner:
                await self.bot_runner.stop()
        finally:
            await self.transport_mgr.cleanup()
        logger.info("Base action_quit: cleanup complete; calling super().action_quit()")
        await super().action_quit()
        logger.info("Base action_quit: end")
