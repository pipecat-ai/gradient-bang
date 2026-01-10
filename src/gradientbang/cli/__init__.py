"""Gradient Bang CLI.

A command-line interface for setting up, running, and deploying Gradient Bang.

Usage:
    uv sync --group cli
    uv run gb --help
"""

from gradientbang.cli.app import app

__all__ = ["app"]

