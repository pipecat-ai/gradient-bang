#!/usr/bin/env python3
"""Iterate regional image prompts and evaluate rendered text fidelity."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import re
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any

from PIL import Image, ImageEnhance, ImageOps

from gradientbang.newspaper.scripts.front_page_regions import (
    ART_DIRECTIONS,
    DEFAULT_LAYOUT,
    DEFAULT_MODEL,
    DEFAULT_QUALITY,
    DEFAULT_COMPOSITE_SIZE,
    IMAGE_GEN,
    ROOT,
    build_units,
    choose_generation_size,
    default_references,
    env_with_api_key,
    parse_front_page_markdown,
    parse_size,
    read_layout,
    references_for_unit,
    scale_bbox,
    sha256_bytes,
    source_copy_for_unit,
)


DEFAULT_OUT_ROOT = ROOT / "artifacts" / "gradient-news-observer-prompt-iterations"


@dataclass(frozen=True)
class PromptIteration:
    number: int
    title: str
    rationale: str
    extra_instructions: str
    art_direction: str | None = None
    use_ship_references: bool = True


ITERATIONS: tuple[PromptIteration, ...] = (
    PromptIteration(
        1,
        "Baseline regional prompt",
        "Establish current behavior before applying stricter text controls.",
        "",
    ),
    PromptIteration(
        2,
        "Remove topic-mismatched ship references",
        "The previous 36-hour story 7 panel invented shipyard content; the static ship references are likely encouraging that.",
        "Do not show ship cards, ship catalogs, shipyard transaction panels, dealer-lot panels, or any transaction sidebar. Use only abstract trade-volume graphics.",
        art_direction=(
            "Trade-volume story panel. Show abstract market flow, bars, routes, and exchange-volume energy. "
            "Do not show ships for sale or shipyard cards."
        ),
        use_ship_references=False,
    ),
    PromptIteration(
        3,
        "No readable decoration",
        "Extra readable side labels are a major defect; explicitly ban all non-source letters and numbers in artwork.",
        "Every readable letter, word, number, table value, icon label, caption, chart label, log entry, side-card, or badge must come from the source copy. Decorative UI may use lines, dots, bars, hexes, and abstract glyphs only. No alphabetic pseudo-text.",
        art_direction=(
            "Trade-volume story panel with abstract charts and hex-route graphics only. "
            "Artwork must be nonverbal except for the article text."
        ),
        use_ship_references=False,
    ),
    PromptIteration(
        4,
        "Whitelist-only typography",
        "Prompt the model to treat the source as an exclusive whitelist, not merely the desired article.",
        "Treat the Source copy as a closed whitelist. If a string does not appear verbatim in Source copy, it must not appear anywhere in the image. Do not add section tabs, chart captions, product cards, status labels, timestamps, legends, ads, or UI labels.",
        art_direction="Quiet trade-volume panel with one article text block and non-readable abstract market chart texture.",
        use_ship_references=False,
    ),
    PromptIteration(
        5,
        "Separate article text from silent art",
        "Define text zone and art zone behavior. The model often puts readable labels inside art.",
        "Use one clear article text area for the headline, section label, and body copy. Any illustration area must be silent art: no readable words, numbers, acronyms, labels, signs, screen text, or captions.",
        art_direction="Article-forward trade-volume panel, with silent abstract chart art behind or below the copy.",
        use_ship_references=False,
    ),
    PromptIteration(
        6,
        "Copy-desk proof mode",
        "Increase pressure on exact spelling, punctuation, and numbers while reducing visual ambition.",
        "Copy-desk proof mode: prioritize legible exact typesetting over illustration. Use simple high-contrast type. Preserve punctuation, dollar signs, commas, capitalization, hyphens, and apostrophes. If art competes with text, remove art.",
        art_direction="Mostly typographic newspaper panel with restrained non-readable trade chart texture.",
        use_ship_references=False,
    ),
    PromptIteration(
        7,
        "Negative examples",
        "List the actual types of invented labels observed in earlier regional outputs.",
        "Forbidden invented text examples: SHIPYARD TRANSACTIONS, CLASS, HULL, STATUS, AVAILABLE, QUALITY SHIPS, FAIR PRICES, FAST TURNAROUND, TRADING BOARD, COMBAT LOG, PATROL CRAFT, MARKET SUMMARY, VOLUME INDEX. Do not render any similar side label.",
        art_direction="No shipyard, no catalog, no market-dashboard labels. A clean article panel with silent visual atmosphere.",
        use_ship_references=False,
    ),
    PromptIteration(
        8,
        "Short-lines exact setting",
        "Long lines can induce word substitutions; ask for conservative line length and larger body text.",
        "Set body text in short, readable lines with generous leading. Do not squeeze text. Do not hyphenate words unless the source word itself contains a hyphen. Never abbreviate or paraphrase.",
        art_direction="Spacious article panel with silent abstract market geometry.",
        use_ship_references=False,
    ),
    PromptIteration(
        9,
        "Literal poster proof",
        "Force a less newspaper-like, more proof-like rendering to see whether visual simplicity improves exactness.",
        "Render this as a proof sheet for a newspaper panel: exact headline, exact section label, exact body copy, then silent decorative border. No extra readable marks. No charts with labels. No sidebars. No captions.",
        art_direction="Proof-like retro-digital newspaper panel with silent border ornament.",
        use_ship_references=False,
    ),
    PromptIteration(
        10,
        "Consolidated best prompt",
        "Combine the strongest hypotheses: no topic-mismatched refs, closed text whitelist, silent art, short lines, and copy-desk proofing.",
        "Final fidelity contract: the source copy is the complete and exclusive text inventory. Render it exactly once in this order: headline, section label, body copy. Preserve every character, number, comma, dollar sign, apostrophe, and hyphen. Use short lines and high-contrast type. All artwork must be silent: no readable labels, no product cards, no chart labels, no signs, no sidebars, no UI text, no pseudo-text.",
        art_direction="Article-first trade-volume panel with a silent Gradient Bang atmosphere: abstract bars, route lines, hex texture, no readable art labels.",
        use_ship_references=False,
    ),
)


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower()).strip()


def expected_tokens(text: str) -> list[str]:
    tokens: list[str] = []
    for token in re.findall(r"[A-Za-z0-9$][A-Za-z0-9,$.'-]*", text):
        if len(token) >= 4 or re.search(r"\d|\$", token):
            tokens.append(token)
    return tokens


def token_metrics(expected: str, observed: str) -> dict[str, Any]:
    tokens = expected_tokens(expected)
    observed_norm = normalize_text(observed)
    hits = [token for token in tokens if normalize_text(token) in observed_norm]
    missing = [token for token in tokens if normalize_text(token) not in observed_norm]
    return {
        "tokens": len(tokens),
        "hits": len(hits),
        "hit_rate": round(len(hits) / len(tokens), 4) if tokens else None,
        "missing": missing[:80],
    }


def numbers(text: str) -> list[str]:
    return re.findall(r"\$?\d[\d,]*(?:\.\d+)?|\d{2}:\d{2}|\d{4}-\d{2}-\d{2}", text)


def forbidden_hits(observed: str) -> list[str]:
    forbidden = [
        "shipyard",
        "transactions",
        "class",
        "hull",
        "status",
        "available",
        "quality",
        "prices",
        "turnaround",
        "trading board",
        "combat log",
        "patrol craft",
        "market summary",
        "volume index",
        "route secure",
    ]
    norm = normalize_text(observed)
    return [term for term in forbidden if term in norm]


def preprocess_for_ocr(path: Path, out: Path) -> None:
    image = Image.open(path).convert("RGB")
    image = ImageOps.expand(image, border=32, fill=(0, 0, 0))
    image = image.resize((image.width * 3, image.height * 3), Image.Resampling.LANCZOS)
    gray = ImageOps.grayscale(image)
    gray = ImageOps.autocontrast(gray, cutoff=1)
    gray = ImageEnhance.Contrast(gray).enhance(2.2)
    prepared = ImageOps.invert(gray)
    prepared.save(out)


def run_ocr(path: Path) -> str:
    command = ["tesseract", str(path), "stdout", "--psm", "6", "-l", "eng"]
    result = subprocess.run(command, check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return result.stdout.strip()


def build_prompt(
    *,
    iteration: PromptIteration,
    unit_id: str,
    source_copy: str,
    target_bbox: tuple[int, int, int, int],
    generation_size: tuple[int, int],
    references: tuple[Path, ...],
    default_art_direction: str,
) -> str:
    refs = "\n".join(
        f"Image {index}: visual reference only, {path.as_posix()}"
        for index, path in enumerate(references, start=1)
    )
    art_direction = iteration.art_direction or default_art_direction
    return f"""Use case: infographic-diagram
Asset type: one independently rendered region for a high-resolution retro-digital newspaper front page

Experiment:
Iteration {iteration.number}: {iteration.title}
Rationale: {iteration.rationale}

Input images:
{refs}

Primary request:
Create ONLY the {unit_id} region, not a complete front page. This output will be composited into a larger newspaper page.

Region geometry:
- Final composite target box: {target_bbox}
- Generation canvas: {generation_size[0]}x{generation_size[1]} px

Visual style:
Retro-digital newspaper page inspired by the supplied Gradient News reference: dark paper, cyan and acid-green ink, HUD borders, hex-map texture, scanlines, engraved-newsprint density, varied newspaper typography, and Gradient Bang ship/UI language. Input images are style references only; do not copy old article text from them.

Region art direction:
{art_direction}

Critical text contract:
1. Render only the readable text listed in "Source copy to render" below.
2. Copy spelling, capitalization, punctuation, names, numbers, money amounts, and dates exactly.
3. Do not add invented readable labels, captions, sector numbers, slogans, ads, watermarks, signatures, player names, values, UI labels, chart labels, side-card labels, or decorative pseudo-text.
4. Do not render Markdown syntax characters used only for formatting, including #, ##, *, **, table separator rows, or horizontal rules.
5. If space is tight, reduce decorative art first. Do not omit, rewrite, abbreviate, or paraphrase source text.
6. Keep all text inside the panel border with safe margins.

Iteration-specific text-fidelity instruction:
{iteration.extra_instructions or "Use the baseline regional text contract exactly."}

Source copy to render:
{source_copy}
"""


def run_iteration(
    *,
    iteration: PromptIteration,
    front_page_md: Path,
    region: str,
    out_dir: Path,
    force: bool,
    dry_run: bool,
    model: str,
    quality: str,
    composite_size: tuple[int, int],
) -> dict[str, Any]:
    layout = read_layout(DEFAULT_LAYOUT)
    front_page = parse_front_page_markdown(front_page_md)
    units = {unit.id: unit for unit in build_units(layout)}
    if region not in units:
        raise SystemExit(f"Unknown region: {region}")
    unit = units[region]
    source_size = (int(layout["source_size"]["width"]), int(layout["source_size"]["height"]))
    target_bbox = scale_bbox(unit.bbox, source_size, composite_size)
    generation_size = choose_generation_size(target_bbox[2] - target_bbox[0], target_bbox[3] - target_bbox[1])

    global_refs = default_references()
    if iteration.use_ship_references:
        references = references_for_unit(unit, global_refs)
    else:
        references = tuple(global_refs)

    source_copy = source_copy_for_unit(front_page, unit)
    prompt = build_prompt(
        iteration=iteration,
        unit_id=region,
        source_copy=source_copy,
        target_bbox=target_bbox,
        generation_size=generation_size,
        references=references,
        default_art_direction=ART_DIRECTIONS.get(region, "Retro-digital newspaper panel."),
    )

    iteration_dir = out_dir / f"iteration-{iteration.number:02d}"
    iteration_dir.mkdir(parents=True, exist_ok=True)
    prompt_path = iteration_dir / f"{region}-prompt.txt"
    output_path = iteration_dir / f"{region}.png"
    ocr_prep_path = iteration_dir / f"{region}-ocrprep.png"
    ocr_path = iteration_dir / f"{region}-ocr.txt"
    evaluation_path = iteration_dir / f"{region}-evaluation.json"
    prompt_path.write_text(prompt, encoding="utf-8")

    command = [
        sys.executable,
        str(IMAGE_GEN),
        "edit",
        "--model",
        model,
        "--size",
        f"{generation_size[0]}x{generation_size[1]}",
        "--quality",
        quality,
        "--prompt-file",
        str(prompt_path),
        "--out",
        str(output_path),
        "--no-augment",
    ]
    for reference in references:
        command.extend(["--image", str(reference)])
    if force:
        command.append("--force")
    if dry_run:
        command.append("--dry-run")

    print(f"Iteration {iteration.number}: {iteration.title}")
    print("Command:", " ".join(shlex.quote(part) for part in command))
    subprocess.run(command, check=True, env=env_with_api_key())

    ocr_text = ""
    if not dry_run:
        preprocess_for_ocr(output_path, ocr_prep_path)
        ocr_text = run_ocr(ocr_prep_path)
        ocr_path.write_text(ocr_text + "\n", encoding="utf-8")

    expected_nums = set(numbers(source_copy))
    observed_nums = set(numbers(ocr_text))
    token_result = token_metrics(source_copy, ocr_text) if not dry_run else {}
    evaluation = {
        "iteration": iteration.number,
        "title": iteration.title,
        "rationale": iteration.rationale,
        "region": region,
        "prompt": str(prompt_path),
        "prompt_sha256": sha256_bytes(prompt.encode("utf-8")),
        "output": str(output_path),
        "ocr_prep": str(ocr_prep_path),
        "ocr": str(ocr_path),
        "generation_size": {"width": generation_size[0], "height": generation_size[1]},
        "references": [str(path) for path in references],
        "used_ship_references": iteration.use_ship_references,
        "token_metrics": token_result,
        "expected_numbers": sorted(expected_nums),
        "observed_numbers": sorted(observed_nums),
        "missing_numbers": sorted(expected_nums - observed_nums),
        "extra_numbers": sorted(observed_nums - expected_nums),
        "forbidden_hits": forbidden_hits(ocr_text),
        "command": command,
        "dry_run": dry_run,
    }
    evaluation_path.write_text(json.dumps(evaluation, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    critique = [
        f"# Iteration {iteration.number}: {iteration.title}",
        "",
        f"Rationale: {iteration.rationale}",
        "",
        f"Prompt: `{prompt_path}`",
        f"Output: `{output_path}`",
        "",
        "## Evaluation",
        "",
    ]
    if dry_run:
        critique.append("Dry run only; no OCR evaluation.")
    else:
        critique.extend(
            [
                f"- Token hit rate: {token_result.get('hit_rate')}",
                f"- Missing numbers from OCR: {', '.join(evaluation['missing_numbers']) or 'none'}",
                f"- Extra numbers from OCR: {', '.join(evaluation['extra_numbers'][:20]) or 'none'}",
                f"- Forbidden readable labels detected by OCR: {', '.join(evaluation['forbidden_hits']) or 'none'}",
                "",
                "## OCR Excerpt",
                "",
                "```text",
                "\n".join(ocr_text.splitlines()[:80]),
                "```",
            ]
        )
    (iteration_dir / "critique.md").write_text("\n".join(critique) + "\n", encoding="utf-8")
    return evaluation


def write_summary(out_dir: Path, evaluations: list[dict[str, Any]]) -> None:
    rows = []
    for item in evaluations:
        metrics = item.get("token_metrics", {})
        rows.append(
            "| {iteration} | {title} | {hit_rate} | {missing_numbers} | {forbidden_hits} | {prompt} | {output} |".format(
                iteration=item["iteration"],
                title=item["title"].replace("|", "\\|"),
                hit_rate=metrics.get("hit_rate"),
                missing_numbers=", ".join(item.get("missing_numbers", [])) or "none",
                forbidden_hits=", ".join(item.get("forbidden_hits", [])) or "none",
                prompt=item["prompt"],
                output=item["output"],
            )
        )
    summary = [
        "# Regional Prompt Text-Fidelity Iteration Work Trail",
        "",
        "This experiment iterates prompt wording for one hard regional story box and records the exact prompt, output image, OCR text, and evaluation for each attempt.",
        "",
        "| Iteration | Prompt change | OCR token hit rate | OCR missing numbers | OCR forbidden labels | Prompt | Output |",
        "| ---: | --- | ---: | --- | --- | --- | --- |",
        *rows,
        "",
        "OCR is an aid, not the final authority. Inspect each PNG and `critique.md` before promoting a prompt into the production regional generator.",
    ]
    (out_dir / "work-trail.md").write_text("\n".join(summary) + "\n", encoding="utf-8")
    (out_dir / "evaluations.json").write_text(json.dumps(evaluations, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Iterate and evaluate regional front-page image prompts.")
    parser.add_argument("--front-page-md", type=Path, required=True)
    parser.add_argument("--region", default="story_07")
    parser.add_argument("--out-dir", type=Path)
    parser.add_argument("--iterations", type=int, default=10)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--quality", default=DEFAULT_QUALITY)
    parser.add_argument("--composite-size", type=parse_size, default=parse_size(DEFAULT_COMPOSITE_SIZE))
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def run(argv: list[str]) -> int:
    args = parse_args(argv)
    if not args.front_page_md.exists():
        raise SystemExit(f"Missing front-page Markdown: {args.front_page_md}")
    if not IMAGE_GEN.exists():
        raise SystemExit(f"Missing image CLI: {IMAGE_GEN}")
    if args.iterations < 1 or args.iterations > len(ITERATIONS):
        raise SystemExit(f"--iterations must be between 1 and {len(ITERATIONS)}")

    out_dir = args.out_dir or (
        DEFAULT_OUT_ROOT
        / f"{args.front_page_md.stem.replace('gradient-news-observer-', '')}-{args.region}"
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    evaluations: list[dict[str, Any]] = []
    for iteration in ITERATIONS[: args.iterations]:
        evaluation = run_iteration(
            iteration=iteration,
            front_page_md=args.front_page_md,
            region=args.region,
            out_dir=out_dir,
            force=args.force,
            dry_run=args.dry_run,
            model=args.model,
            quality=args.quality,
            composite_size=args.composite_size,
        )
        evaluations.append(evaluation)
        write_summary(out_dir, evaluations)
    print(f"Wrote work trail: {out_dir / 'work-trail.md'}")
    return 0


def main() -> int:
    return run(sys.argv[1:])


if __name__ == "__main__":
    raise SystemExit(main())
