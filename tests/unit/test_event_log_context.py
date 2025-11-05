"""Ensure server event emissions always include log context metadata."""

from __future__ import annotations

import ast
from pathlib import Path


EMITTER_ROOT = Path("game-server")


class _EmitVisitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.missing: list[tuple[Path, int]] = []

    def visit_Call(self, node: ast.Call) -> None:  # noqa: D401 - ast visitor
        if isinstance(node.func, ast.Attribute) and node.func.attr == "emit":
            if isinstance(node.func.value, ast.Name) and node.func.value.id == "event_dispatcher":
                if not any(keyword.arg == "log_context" for keyword in node.keywords):
                    self.missing.append((self._current_file, node.lineno))
        self.generic_visit(node)

    def scan(self, path: Path) -> None:
        self._current_file = path
        tree = ast.parse(path.read_text(encoding="utf-8"))
        self.visit(tree)


def test_event_dispatcher_emit_requires_log_context() -> None:
    visitor = _EmitVisitor()
    for py_file in EMITTER_ROOT.rglob("*.py"):
        visitor.scan(py_file)

    assert (
        visitor.missing == []
    ), "event_dispatcher.emit calls missing log_context: " + ", ".join(
        f"{path}:{lineno}" for path, lineno in visitor.missing
    )
