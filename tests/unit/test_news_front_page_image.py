from __future__ import annotations

import hashlib

import pytest

from gradientbang.newspaper.scripts.front_page_image import (
    backend_argv,
    build_prompt,
    normalized_front_page_text,
    parse_args,
)


def test_front_page_prompt_is_deterministic(tmp_path):
    front_page = tmp_path / "front-page.md"
    front_page.write_text(
        "# THE GRADIENT NEWS & OBSERVER\r\n\r\n"
        "**Front-Page Edition -- Test**\r\n\r\n"
        "*\"All the news the void allows.\"*\r\n",
        encoding="utf-8",
    )

    first = build_prompt(front_page)
    second = build_prompt(front_page)

    assert first == second
    assert "\r" not in first
    assert hashlib.sha256(first.encode("utf-8")).hexdigest() == hashlib.sha256(
        second.encode("utf-8")
    ).hexdigest()


def test_front_page_markdown_is_embedded_verbatim_except_newlines(tmp_path):
    front_page = tmp_path / "front-page.md"
    front_page.write_text("## 1. Exact Headline\r\n\r\nBody text.\r\n", encoding="utf-8")

    assert normalized_front_page_text(front_page) == "## 1. Exact Headline\n\nBody text.\n"
    assert build_prompt(front_page).endswith("## 1. Exact Headline\n\nBody text.\n")


def test_wrapper_defaults_to_composited_regions(tmp_path):
    front_page = tmp_path / "front-page.md"
    out = tmp_path / "front-page.png"
    metadata = tmp_path / "metadata.json"
    front_page.write_text("# THE GRADIENT NEWS & OBSERVER\n", encoding="utf-8")

    args = parse_args(
        [
            "--front-page-md",
            str(front_page),
            "--out",
            str(out),
            "--metadata-out",
            str(metadata),
            "--dry-run",
        ]
    )
    argv = backend_argv(args)

    assert args.renderer == "composited-regions"
    assert argv[:2] == ["--front-page-md", str(front_page)]
    assert "--out" in argv
    assert str(out) in argv
    assert "--metadata-out" in argv
    assert str(metadata) in argv
    assert "--dry-run" in argv


def test_wrapper_one_shot_preserves_old_arguments(tmp_path):
    front_page = tmp_path / "front-page.md"
    reference = tmp_path / "reference.png"
    out = tmp_path / "front-page.png"
    prompt = tmp_path / "prompt.txt"
    front_page.write_text("# THE GRADIENT NEWS & OBSERVER\n", encoding="utf-8")
    reference.write_bytes(b"png")

    args = parse_args(
        [
            "--renderer",
            "one-shot",
            "--front-page-md",
            str(front_page),
            "--reference",
            str(reference),
            "--out",
            str(out),
            "--prompt-out",
            str(prompt),
            "--size",
            "2160x3840",
            "--dry-run",
        ]
    )
    argv = backend_argv(args)

    assert argv[:2] == ["--front-page-md", str(front_page)]
    assert argv.count("--reference") == 1
    assert str(reference) in argv
    assert "--prompt-out" in argv
    assert str(prompt) in argv
    assert "--size" in argv
    assert "2160x3840" in argv


def test_wrapper_rejects_one_shot_only_prompt_path_for_regions(tmp_path):
    front_page = tmp_path / "front-page.md"
    front_page.write_text("# THE GRADIENT NEWS & OBSERVER\n", encoding="utf-8")

    args = parse_args(
        [
            "--front-page-md",
            str(front_page),
            "--prompt-out",
            str(tmp_path / "prompt.txt"),
        ]
    )

    with pytest.raises(SystemExit):
        backend_argv(args)
