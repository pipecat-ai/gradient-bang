from __future__ import annotations

from typing import Optional

from textual.widgets import ListItem, Static


class PlaceholderListMixin:
    """Mixin for ListView-like widgets to show a one-time placeholder row.

    - Call `add_placeholder()` once after mount to ensure the list renders even
      when initially empty (useful when container starts hidden).
    - Call `hide_placeholder()` before appending the first real row.
    """

    _placeholder_item: Optional[ListItem] = None

    async def add_placeholder(self, text: str = "...") -> None:  # type: ignore[override]
        if self._placeholder_item is None:
            self._placeholder_item = ListItem(Static(text), classes="-placeholder")
            # type: ignore[attr-defined]
            await self.append(self._placeholder_item)

    def hide_placeholder(self) -> None:
        try:
            if self._placeholder_item is not None:
                self._placeholder_item.display = False
                self._placeholder_item = None
        except Exception:
            self._placeholder_item = None


class AutoScrollMixin:
    """Mixin to provide smart auto-scroll on append.

    If the viewport is already scrolled to the bottom when new content is
    appended, auto-scroll to keep the newest content visible. If the user has
    scrolled up, do not change the scroll position.
    """

    def _is_at_bottom(self) -> bool:
        try:
            # Heuristic based on scroll offset and virtual size
            vs = self.virtual_size.height  # type: ignore[attr-defined]
            vh = self.size.height  # type: ignore[attr-defined]
            oy = self.scroll_offset.y  # type: ignore[attr-defined]
            return oy >= max(0, vs - vh - 1)
        except Exception:
            # Fallback: default to autoscroll
            return True

    def _auto_scroll_if_needed(self) -> None:
        try:
            self.scroll_end(animate=False)  # type: ignore[attr-defined]
        except Exception:
            pass
