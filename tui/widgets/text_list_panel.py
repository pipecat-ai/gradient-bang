from textual.widgets import ListView, ListItem, Static
from tui.widgets.mixins import PlaceholderListMixin, AutoScrollMixin


class TextListPanel(AutoScrollMixin, PlaceholderListMixin, ListView):
    """A simple list view that appends plain text items."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._last_item = None
        self._last_text = ""
        # placeholder handled by mixin in on_mount

    async def on_mount(self) -> None:  # type: ignore[override]
        await self.add_placeholder("…")

    async def append_text_item(self, text: str) -> None:
        at_bottom = self._is_at_bottom()
        self.hide_placeholder()
        self._last_item = ListItem(Static(text))
        self._last_text = text
        await self.append(self._last_item)
        if at_bottom:
            self._auto_scroll_if_needed()

    # Alias commonly-used name
    async def append_text(self, text: str) -> None:
        await self.append_text_item(text)

    async def append_text_to_last_item(self, text: str) -> None:
        if self._last_item is not None:
            self._last_text = self._last_text + text
            self._last_item.children[0].update(self._last_text)
            # Keep view pinned if already at bottom
            if self._is_at_bottom():
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
        try:
            static = item.query_one(Static)
            return str(static.renderable)
        except Exception:
            return None
