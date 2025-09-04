from textual.widgets import Log
from tui.widgets.mixins import AutoScrollMixin


class SyslogPanel(AutoScrollMixin, Log):
    DEFAULT_CSS = """
    SyslogPanel { border: round $primary; }
    """
    def write_line(self, line: str) -> None:  # type: ignore[override]
        at_bottom = self._is_at_bottom()
        super().write_line(line)
        if at_bottom:
            self._auto_scroll_if_needed()
