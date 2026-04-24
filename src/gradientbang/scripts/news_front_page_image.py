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


ROOT = Path(__file__).resolve().parents[3]
IMAGE_GEN = Path.home() / ".codex" / "skills" / ".system" / "imagegen" / "scripts" / "image_gen.py"

DEFAULT_REFERENCE = ROOT / "artifacts" / "gradient-news-observer-images" / "front-page-04.png"
DEFAULT_IMAGE_DIR = ROOT / "artifacts" / "gradient-news-observer-images"
DEFAULT_MODEL = "gpt-image-2"
DEFAULT_SIZE = "2160x3840"
DEFAULT_QUALITY = "high"

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


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate a Gradient News front-page image from front-page Markdown."
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


def run(argv: list[str]) -> int:
    args = parse_args(argv)
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


def main() -> int:
    return run(sys.argv[1:])


if __name__ == "__main__":
    raise SystemExit(main())
