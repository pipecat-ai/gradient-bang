#!/usr/bin/env python3
"""Generate a wide masthead-style banner image from a Markdown copy file.

Reuses the newspaper image-edit pipeline (image_gen.py + masthead reference)
to render a single banner — e.g. a "CALL TO ARMS" recruitment header —
that matches *The Gradient News & Observer* aesthetic without forcing the
ten-section front-page layout.

Example:
  uv run news-banner \\
      --copy-file artifacts/banners/call-to-arms.md \\
      --out artifacts/banners/call-to-arms.png
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

from gradientbang.newspaper.scripts import front_page_regions


ROOT = Path(__file__).resolve().parents[4]
IMAGE_GEN = Path(__file__).with_name("image_gen.py")

DEFAULT_REFERENCE = (
    front_page_regions.DEFAULT_REFERENCE_DIR / "masthead-style-wed-thu-pt.png"
)
DEFAULT_OUTPUT_DIR = ROOT / "artifacts" / "banners"
DEFAULT_MODEL = "gpt-image-2"
DEFAULT_SIZE = "2048x1024"
DEFAULT_QUALITY = "high"

PROMPT_TEMPLATE_VERSION = "gradient-news-banner-v1"
PROMPT_PREAMBLE = """Use case: text-localization
Asset type: high-resolution wide landscape banner image, sized for use as a website / Discord header.

Input image role:
Use the supplied image as the visual style reference. Preserve its retro-digital newspaper masthead aesthetic: ornate Gradient Bang display typography, dark paper texture, subtle hex-map and HUD linework, ship illustrations, slight scanline / printed-paper grain. Do NOT reproduce the supplied image's literal masthead text — replace it with the headline and copy supplied below.

Primary request:
Compose a single-panel banner that reads as a special-edition broadside from THE GRADIENT NEWS & OBSERVER. One dramatic headline, a short subhead, a brief body, and a clear call-to-action line. Treat it like a wartime recruitment poster filtered through the newspaper's typographic universe.

Critical text contract:
1. Visible banner text must be copied literally from the source copy below.
2. Do not paraphrase, summarize, rewrite, reorder, translate, correct, or embellish any visible word.
3. Do not invent any extra readable slogans, fake URLs, fake player names, fake sector numbers, fake dates, captions, or labels.
4. If space is tight, reduce type size or trim decorative elements. Do not solve space pressure by changing copy.
5. Render every line that appears in the source copy below; render no other readable text.
6. Keep the small kicker line (top, all-caps, smaller type) exactly as written.
7. Keep the headline (largest type, dominant on the banner) exactly as written.
8. Keep the subhead and body exactly as written.
9. Keep the call-to-action line at the bottom exactly as written, including any URL.

Layout direction:
Banner orientation, single panel. Headline dominates the composition. Use bold retro-digital display type for the headline, smaller readable type for subhead and body, a distinct call-to-action line set off at the bottom. Decorate with one or two ship silhouettes, hex-grid fragments, and Gradient Bang HUD elements — but never let decoration crowd the readable text. The overall mood is urgent, theatrical, recruitment-poster, but typographically continuous with the existing newspaper.

Privacy and content constraints:
Use only the source copy below as readable text. Do not add new claims beyond the source copy. Do not add fake player names, sector numbers, or invite codes.

Source copy to render verbatim:

"""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def normalized_copy_text(path: Path) -> str:
    return (
        path.read_text(encoding="utf-8")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .strip()
        + "\n"
    )


def build_prompt(copy_md: Path) -> str:
    return PROMPT_PREAMBLE + normalized_copy_text(copy_md)


def env_with_api_key() -> dict[str, str]:
    env = dict(os.environ)
    if "OPENAI_API_KEY" in env:
        return env
    dotenv = ROOT / ".env"
    if dotenv.exists():
        for line in dotenv.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            if key.strip() == "OPENAI_API_KEY":
                env["OPENAI_API_KEY"] = value.strip().strip('"').strip("'")
                break
    return env


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Generate a single masthead-style banner image from a Markdown "
            "copy file, using the newspaper's image-edit pipeline."
        ),
    )
    parser.add_argument(
        "--copy-file",
        type=Path,
        required=True,
        help="Markdown file containing the verbatim banner copy.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Output PNG path (default: artifacts/banners/<copy-stem>.png).",
    )
    parser.add_argument(
        "--reference",
        type=Path,
        default=DEFAULT_REFERENCE,
        help="Style reference image (default: masthead style PNG).",
    )
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument(
        "--size",
        default=DEFAULT_SIZE,
        help=(
            "Output size WxH; both dims must be multiples of 16 "
            "(default: 2048x1024 — 2:1 wide banner)."
        ),
    )
    parser.add_argument("--quality", default=DEFAULT_QUALITY)
    parser.add_argument("--prompt-out", type=Path, default=None)
    parser.add_argument("--metadata-out", type=Path, default=None)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])

    if not args.copy_file.exists():
        raise SystemExit(f"Missing copy file: {args.copy_file}")
    if not args.reference.exists():
        raise SystemExit(f"Missing reference image: {args.reference}")
    if not IMAGE_GEN.exists():
        raise SystemExit(f"Missing image CLI: {IMAGE_GEN}")

    out = args.out or (DEFAULT_OUTPUT_DIR / f"{args.copy_file.stem}.png")
    prompt_out = args.prompt_out or (out.parent / f"prompt-{out.stem}.txt")
    metadata_out = args.metadata_out or out.with_suffix(out.suffix + ".json")

    out.parent.mkdir(parents=True, exist_ok=True)
    prompt_out.parent.mkdir(parents=True, exist_ok=True)
    metadata_out.parent.mkdir(parents=True, exist_ok=True)

    prompt = build_prompt(args.copy_file)
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
        "copy_file": str(args.copy_file),
        "copy_file_sha256": sha256_file(args.copy_file),
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
    }
    metadata_out.write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    print("Copy:", args.copy_file)
    print("Prompt:", prompt_out)
    print("Prompt SHA256:", metadata["prompt_sha256"])
    print("Output:", out)
    print("Metadata:", metadata_out)
    print("Command:", " ".join(shlex.quote(part) for part in cmd))
    subprocess.run(cmd, check=True, env=env_with_api_key())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
