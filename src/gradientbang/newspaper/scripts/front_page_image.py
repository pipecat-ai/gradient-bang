#!/usr/bin/env python3
"""Generate a Gradient News front-page image from front-page Markdown."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

from gradientbang.newspaper.scripts import front_page_regions


ROOT = Path(__file__).resolve().parents[4]
IMAGE_GEN = Path(__file__).with_name("image_gen.py")

DEFAULT_REFERENCE = front_page_regions.DEFAULT_FULL_PAGE_REFERENCE
DEFAULT_IMAGE_DIR = ROOT / "artifacts" / "gradient-news-observer-images"
DEFAULT_MODEL = "gpt-image-2"
DEFAULT_SIZE = "2160x3840"
DEFAULT_QUALITY = "high"
DEFAULT_RENDERER = "composited-regions"
RENDERERS = ("composited-regions", "one-shot")

PROMPT_TEMPLATE_VERSION = "gradient-news-single-prompt-v1"
PROMPT_PREAMBLE = """Use case: text-localization
Asset type: high-resolution portrait retro-digital newspaper front page, 2160x3840

Input image role:
Use the supplied image as the visual style and composition reference. Preserve the best qualities of that image: the ornate masthead typography, dark retro-digital newspaper atmosphere, Gradient Bang HUD linework, multi-column front-page rhythm, detailed ship illustrations, hex-map details, market update box, and varied news holes.

Primary request:
Create a complete newspaper front page for THE GRADIENT NEWS & OBSERVER using the source copy below.

Critical text contract:
1. Visible article text must be copied literally from the source copy below.
2. Do not paraphrase, summarize, rewrite, reorder, translate, correct, or embellish any visible headline, section label, paragraph, table label, table value, motto, edition line, or footnote.
3. Do not invent any extra readable slogans, fake facts, fake player names, fake sector numbers, fake percentages, sidebar bulletins, captions, ads, or labels.
4. If space is tight, reduce type size or use fewer decorative elements. Do not solve space pressure by changing article text.
5. For articles 1 through 9, include the headline, section label, and the first two body paragraphs exactly as written.
6. For article 10, include both tables exactly as written, including every row and value, plus the footnote exactly as written.
7. Keep the masthead exactly: "THE GRADIENT NEWS & OBSERVER"
8. Keep the motto exactly: "All the news the void allows."
9. Keep the edition line exactly as written in the source copy.

Layout direction:
Make the layout feel like a real newspaper front page with varied news holes, not a regular grid. Use one large lead story, several medium stories, two smaller gossip-column boxes, and one tabular market update box. Use bold retro-digital typography for headlines, smaller but readable body copy, and illustrated panels in the style of Gradient Bang ship/UI assets. Preserve the dramatic masthead feel of the supplied reference image.

Privacy and content constraints:
Use only the source copy below as readable text. Do not add non-public sector references. Do not add private DM content. Do not add invite codes except where they appear in the source copy. Do not add new claims beyond the source copy.

Source copy to render verbatim:

"""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def normalized_front_page_text(path: Path) -> str:
    # Normalize only newline representation so prompt bytes are stable across
    # platforms. Do not parse, rewrap, or rewrite the front-page Markdown.
    return path.read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n").strip() + "\n"


def build_prompt(front_page_md: Path) -> str:
    return PROMPT_PREAMBLE + normalized_front_page_text(front_page_md)


def env_with_api_key() -> dict[str, str]:
    env = os.environ.copy()
    if env.get("OPENAI_API_KEY"):
        return env
    dotenv = ROOT / ".env"
    if not dotenv.exists():
        return env
    for line in dotenv.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^OPENAI_API_KEY=(.*)$", line.strip())
        if match:
            value = match.group(1).strip().strip('"').strip("'")
            if value:
                env["OPENAI_API_KEY"] = value
            break
    return env


def default_stem(front_page_md: Path) -> str:
    return front_page_md.stem.replace("gradient-news-observer-", "front-page-single-prompt-")


def parse_one_shot_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate a Gradient News front-page image with the one-shot renderer."
    )
    parser.add_argument("--front-page-md", type=Path, required=True, help="Newspaper front-page Markdown to lay out.")
    parser.add_argument("--reference", type=Path, default=DEFAULT_REFERENCE, help="Visual reference image for masthead/layout style.")
    parser.add_argument("--out", type=Path, help="Output PNG path. Defaults to artifacts/gradient-news-observer-images/<front-page-md stem>.png.")
    parser.add_argument("--prompt-out", type=Path, help="Prompt path. Defaults beside --out as prompt-<stem>.txt.")
    parser.add_argument("--metadata-out", type=Path, help="Metadata path. Defaults beside --out as <out>.json.")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--size", default=DEFAULT_SIZE)
    parser.add_argument("--quality", default=DEFAULT_QUALITY)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def run_one_shot(argv: list[str]) -> int:
    args = parse_one_shot_args(argv)
    if not args.front_page_md.exists():
        raise SystemExit(f"Missing front-page Markdown: {args.front_page_md}")
    if not args.reference.exists():
        raise SystemExit(f"Missing reference image: {args.reference}")
    if not IMAGE_GEN.exists():
        raise SystemExit(f"Missing image CLI: {IMAGE_GEN}")

    stem = default_stem(args.front_page_md)
    out = args.out or (DEFAULT_IMAGE_DIR / f"{stem}.png")
    prompt_out = args.prompt_out or (out.parent / f"prompt-{out.stem}.txt")
    metadata_out = args.metadata_out or out.with_suffix(out.suffix + ".json")

    out.parent.mkdir(parents=True, exist_ok=True)
    prompt_out.parent.mkdir(parents=True, exist_ok=True)
    metadata_out.parent.mkdir(parents=True, exist_ok=True)

    prompt = build_prompt(args.front_page_md)
    prompt_bytes = prompt.encode("utf-8")
    prompt_out.write_bytes(prompt_bytes)

    cmd = [
        sys.executable,
        str(IMAGE_GEN),
        "edit",
        "--model",
        args.model,
        "--size",
        args.size,
        "--quality",
        args.quality,
        "--image",
        str(args.reference),
        "--prompt-file",
        str(prompt_out),
        "--out",
        str(out),
        "--no-augment",
    ]
    if args.force:
        cmd.append("--force")
    if args.dry_run:
        cmd.append("--dry-run")

    metadata = {
        "template_version": PROMPT_TEMPLATE_VERSION,
        "front_page_md": str(args.front_page_md),
        "front_page_md_sha256": sha256_file(args.front_page_md),
        "reference": str(args.reference),
        "reference_sha256": sha256_file(args.reference),
        "prompt": str(prompt_out),
        "prompt_sha256": sha256_bytes(prompt_bytes),
        "output": str(out),
        "model": args.model,
        "size": args.size,
        "quality": args.quality,
        "command": cmd,
        "dry_run": args.dry_run,
        "notes": "Prompt generation is deterministic for the same front-page Markdown bytes and template version. Image generation is not bit-deterministic.",
    }
    metadata_out.write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print("Front page:", args.front_page_md)
    print("Prompt:", prompt_out)
    print("Prompt SHA256:", metadata["prompt_sha256"])
    print("Output:", out)
    print("Metadata:", metadata_out)
    print("Command:", " ".join(shlex.quote(part) for part in cmd))
    subprocess.run(cmd, check=True, env=env_with_api_key())
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Generate a Gradient News front-page image from front-page Markdown. "
            "Defaults to the composited-regions renderer."
        )
    )
    parser.add_argument(
        "--renderer",
        choices=RENDERERS,
        default=DEFAULT_RENDERER,
        help="Rendering backend. Defaults to composited-regions.",
    )
    parser.add_argument("--front-page-md", type=Path, required=True, help="Newspaper front-page Markdown to lay out.")
    parser.add_argument(
        "--reference",
        type=Path,
        action="append",
        help=(
            "Visual reference image. For composited-regions, may be repeated and defaults "
            "to the standard reference set. For one-shot, at most one reference is allowed."
        ),
    )
    parser.add_argument(
        "--out",
        type=Path,
        help="Final output PNG path. For composited-regions, this is the composite PNG.",
    )
    parser.add_argument("--prompt-out", type=Path, help="One-shot prompt path.")
    parser.add_argument("--metadata-out", type=Path, help="Metadata JSON path.")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--quality", default=DEFAULT_QUALITY)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")

    parser.add_argument("--size", help="One-shot image size, for example 2160x3840.")
    parser.add_argument("--layout", type=Path, help="Composited-regions layout geometry JSON.")
    parser.add_argument("--out-dir", type=Path, help="Composited-regions output directory for prompts and region PNGs.")
    parser.add_argument("--composite-size", help="Composited-regions final page size, for example 2336x3504.")
    parser.add_argument("--region", action="append", help="Composited-regions: generate only this region id. May be repeated.")
    parser.add_argument("--composite-only", action="store_true", help="Composited-regions: compose existing region PNGs.")
    parser.add_argument(
        "--dark-mode",
        action="store_true",
        help=(
            "Composited-regions only: render in dark mode (cyan and chartreuse ink on dark "
            "paper, names highlighted in cyan). Default is linotype light mode."
        ),
    )
    return parser.parse_args(argv)


def backend_argv(args: argparse.Namespace) -> list[str]:
    if args.renderer == "one-shot":
        one_shot_only = {
            "--layout": args.layout,
            "--out-dir": args.out_dir,
            "--composite-size": args.composite_size,
            "--region": args.region,
            "--composite-only": args.composite_only,
            "--dark-mode": args.dark_mode,
        }
        unsupported = [name for name, value in one_shot_only.items() if value]
        if unsupported:
            raise SystemExit(f"{', '.join(unsupported)} require --renderer composited-regions")
        if args.reference and len(args.reference) > 1:
            raise SystemExit("--renderer one-shot accepts at most one --reference")

        one_shot_argv = ["--front-page-md", str(args.front_page_md)]
        one_shot_argv.extend(["--reference", str(args.reference[0] if args.reference else DEFAULT_REFERENCE)])
        if args.out:
            one_shot_argv.extend(["--out", str(args.out)])
        if args.prompt_out:
            one_shot_argv.extend(["--prompt-out", str(args.prompt_out)])
        if args.metadata_out:
            one_shot_argv.extend(["--metadata-out", str(args.metadata_out)])
        one_shot_argv.extend(["--model", args.model, "--size", args.size or DEFAULT_SIZE, "--quality", args.quality])
        if args.force:
            one_shot_argv.append("--force")
        if args.dry_run:
            one_shot_argv.append("--dry-run")
        return one_shot_argv

    if args.prompt_out:
        raise SystemExit("--prompt-out is only supported with --renderer one-shot")
    if args.size:
        raise SystemExit("--size is only supported with --renderer one-shot; use --composite-size for composited-regions")

    regions_argv = ["--front-page-md", str(args.front_page_md)]
    if args.layout:
        regions_argv.extend(["--layout", str(args.layout)])
    if args.out_dir:
        regions_argv.extend(["--out-dir", str(args.out_dir)])
    if args.out:
        regions_argv.extend(["--out", str(args.out)])
    if args.metadata_out:
        regions_argv.extend(["--metadata-out", str(args.metadata_out)])
    for reference in args.reference or []:
        regions_argv.extend(["--reference", str(reference)])
    if args.composite_size:
        regions_argv.extend(["--composite-size", args.composite_size])
    regions_argv.extend(["--model", args.model, "--quality", args.quality])
    for region in args.region or []:
        regions_argv.extend(["--region", region])
    if args.force:
        regions_argv.append("--force")
    if args.dry_run:
        regions_argv.append("--dry-run")
    if args.composite_only:
        regions_argv.append("--composite-only")
    if args.dark_mode:
        regions_argv.append("--dark-mode")
    return regions_argv


def run(argv: list[str]) -> int:
    args = parse_args(argv)
    selected_backend_argv = backend_argv(args)
    print(f"Renderer: {args.renderer}")
    if args.renderer == "one-shot":
        return run_one_shot(selected_backend_argv)
    return front_page_regions.run(selected_backend_argv)


def main() -> int:
    return run(sys.argv[1:])


if __name__ == "__main__":
    raise SystemExit(main())
