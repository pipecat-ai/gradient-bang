from __future__ import annotations

from typing import Any

from textual.app import ComposeResult
from textual.widgets import ListView, ListItem, Collapsible, Static
from tui.widgets.mixins import PlaceholderListMixin, AutoScrollMixin

from tui.core.utils.json_render import compact_json, pretty_json


class RTVIListPanel(AutoScrollMixin, PlaceholderListMixin, ListView):
    DEFAULT_CSS = """
    RTVIListPanel { border: round $primary; }
    RTVIListPanel ListItem { padding: 0; }
    RTVIListPanel Collapsible { padding-left: 0; padding-bottom: 0; border: none; }
    RTVIListPanel CollapsibleTitle { padding: 0 1; height: 1; }
    RTVIListPanel ListItem.-highlight CollapsibleTitle {
        background: $block-cursor-background;
        color: $block-cursor-foreground;
        text-style: $block-cursor-text-style;
    }
    """
    """ListView that displays RTVI messages as collapsible items.

    - Compact title: one-line JSON
    - Expanded content: pretty-printed JSON
    - Unified selection on mouse / arrow keys
    - `copy_current()` returns text to copy (pretty when expanded, compact otherwise)
    """

    def compose(self) -> ComposeResult:  # type: ignore[override]
        yield from ()

    async def on_mount(self) -> None:  # type: ignore[override]
        # Ensure an initial row so the list renders even when empty/hidden first
        await self.add_placeholder("…")

    async def append_json(self, payload: Any) -> None:
        at_bottom = self._is_at_bottom()
        # Hide placeholder on first real item
        self.hide_placeholder()
        title = compact_json(payload)
        pretty = pretty_json(payload)
        c = Collapsible(Static(pretty), title=title, collapsed=True)
        setattr(c, "_compact_text", title)
        setattr(c, "_pretty_text", pretty)
        await self.append(ListItem(c))
        if at_bottom:
            self._auto_scroll_if_needed()

    def copy_current(self) -> str | None:
        item = self.highlighted_child
        if item is None:
            try:
                item = self.query("ListItem.-highlight").first()
            except Exception:
                item = None
        if not item:
            return None
        c = item.query_one(Collapsible)
        if c.collapsed:
            return getattr(c, "_compact_text", c.title)
        return getattr(c, "_pretty_text", str(c.query_one(Static).renderable))
