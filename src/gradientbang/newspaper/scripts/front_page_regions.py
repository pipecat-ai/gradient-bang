#!/usr/bin/env python3
"""Generate a Gradient News front page as independently rendered regions."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
from importlib.resources import files
import json
import math
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[4]
IMAGE_GEN = Path(__file__).with_name("image_gen.py")
PACKAGE_ASSETS = files("gradientbang.newspaper.assets")


def asset_path(*parts: str) -> Path:
    return Path(str(PACKAGE_ASSETS.joinpath(*parts)))


DEFAULT_LAYOUT = asset_path("layout", "front-page-04-geometry.json")
DEFAULT_OUTPUT_ROOT = ROOT / "artifacts" / "gradient-news-observer-regions"
DEFAULT_REFERENCE_DIR = asset_path("references")
DEFAULT_FULL_PAGE_REFERENCE = DEFAULT_REFERENCE_DIR / "full-page-style-fri-sat-pt.png"
DEFAULT_MASTHEAD_REFERENCE = DEFAULT_REFERENCE_DIR / "masthead-style-wed-thu-pt.png"
DEFAULT_UI_REFERENCE = DEFAULT_REFERENCE_DIR / "gradient-bang-ui.png"
DEFAULT_MODEL = "gpt-image-2"
DEFAULT_QUALITY = "high"
DEFAULT_COMPOSITE_SIZE = "2336x3504"

TEMPLATE_VERSION = "gradient-news-regional-prompt-v5-consistent-headline-type"
GOSSIP_SPLIT_GUTTER = 10

GPT_IMAGE_2_MIN_PIXELS = 655_360
GPT_IMAGE_2_MAX_PIXELS = 8_294_400
GPT_IMAGE_2_MAX_EDGE = 3840
GPT_IMAGE_2_MAX_RATIO = 3.0


@dataclass(frozen=True)
class Story:
    number: int
    headline: str
    section_label: str
    body_text: str
    render_text: str


@dataclass(frozen=True)
class FrontPageCopy:
    title: str
    edition_line: str
    motto: str
    stories: dict[int, Story]


@dataclass(frozen=True)
class GenerationUnit:
    id: str
    role: str
    bbox: tuple[int, int, int, int]
    story_numbers: tuple[int, ...] = ()
    description: str = ""


@dataclass(frozen=True)
class PlannedRegion:
    unit: GenerationUnit
    target_bbox: tuple[int, int, int, int]
    generation_size: tuple[int, int]
    output: Path
    prompt: Path
    references: tuple[Path, ...]
    command: tuple[str, ...]


SHIP_REFERENCES = {
    "story_01": ("client/app/src/assets/images/ships/sovereign_starcruiser.png",),
    "story_02": (
        "client/app/src/assets/images/ships/pike_frigate.png",
        "client/app/src/assets/images/ships/sovereign_starcruiser.png",
    ),
    "story_03": ("client/app/src/assets/images/ships/corsair_raider_logo.png",),
    "story_04": ("client/app/src/assets/images/ships/bulwark_destroyer.png",),
    "story_05": ("client/app/src/assets/images/ships/autonomous_probe.png",),
    "story_06": (
        "client/app/src/assets/images/ships/atlas_hauler.png",
        "client/app/src/assets/images/ships/wayfarer_freighter.png",
    ),
    "story_07": (
        "client/app/src/assets/images/ships/kestrel_courier.png",
        "client/app/src/assets/images/ships/parhelion_seeker.png",
        "client/app/src/assets/images/ships/wayfarer_freighter.png",
    ),
    "story_08": ("client/app/src/assets/images/ships/escape_pod_logo.png",),
    "story_09": (
        "client/app/src/assets/images/ships/kestrel_courier_logo.png",
        "client/app/src/assets/images/ships/sovereign_starcruiser.png",
    ),
}

ART_DIRECTIONS = {
    "header": (
        "Ornate but digital masthead nameplate, combining the elegance of an old newspaper "
        "engraving with Gradient Bang HUD linework. The header slot is very wide; place the "
        "important lettering in a central horizontal band so center-cropping keeps it intact."
    ),
    "story_01": (
        "Large lead-story panel. Show a Sovereign Starcruiser looming over a lonely toll-lane "
        "checkpoint in deep space, with no invented sector labels."
    ),
    "story_02": (
        "Upper-right enforcement story. Show an abstract garrison outpost near a Federation "
        "buffer boundary, a patrol craft, hex-map linework, and combat log energy."
    ),
    "story_03": (
        "Small corporation recruitment story. Show a sharp Gradient Fang-style emblem, dark "
        "terminal glow, and a direct recruitment notice feel."
    ),
    "story_04": (
        "Small combat-losses story. Show broken hull fragments, debris, and a compact combat "
        "aftermath graphic, not a full battle scene."
    ),
    "story_05": (
        "Small exploration story. Show an autonomous probe scanning hex sectors and expanding "
        "a universe map."
    ),
    "story_06": (
        "Small trading leaderboard story. Show three ranked ship cards or freighter silhouettes "
        "on a trading board."
    ),
    "story_07": (
        "Small shipyard transactions story. Show ships displayed like a retro-digital dealer "
        "lot or parts catalog."
    ),
    "story_08": (
        "Small gossip story box. Use a sly newspaper-column tone, a compact escape-pod or "
        "wreckage emblem, and restrained silent ornamentation. Do not add a shared gossip "
        "header outside the story's own section label."
    ),
    "story_09": (
        "Small gossip story box. Evoke a starcruiser captain, trade lanes, a concierge map, "
        "and a sly dockside rumor tone. Do not add a shared gossip header outside the "
        "story's own section label."
    ),
    "story_10": (
        "Market update box. Prioritize table readability, rows, values, and a compact chart. "
        "Use restrained graphics so the numbers remain legible. This region is a market "
        "statistics box only. Forbidden text for this market region: THE GRADIENT NEWS & "
        "OBSERVER, GRADIENT NEWS, OBSERVER, ALL THE NEWS THE VOID ALLOWS, A JOURNAL "
        "DEVOTED, VOL., No., ONE CREDIT, SATURDAY, APRIL, 2610, TRUTH BY REASON. Do not "
        "render any similar masthead, dateline, price line, publication identity, "
        "newspaper nameplate, motto, volume number, or page-header furniture."
    ),
    "footer": (
        "Tiny ornamental bottom strip only. Use abstract cyan data ticks and small framing "
        "details. No readable article text."
    ),
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def normalize_newlines(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def strip_outer_markdown_emphasis(line: str) -> str:
    stripped = line.strip()
    if stripped.startswith("**") and stripped.endswith("**") and len(stripped) >= 4:
        return stripped[2:-2]
    if stripped.startswith("*") and stripped.endswith("*") and len(stripped) >= 2:
        return stripped[1:-1]
    return stripped


def is_markdown_table_separator(line: str) -> bool:
    stripped = line.strip()
    if not stripped.startswith("|"):
        return False
    cells = [cell.strip() for cell in stripped.strip("|").split("|")]
    return bool(cells) and all(cell and set(cell) <= {"-", ":", " "} for cell in cells)


def clean_body_lines(lines: list[str]) -> str:
    cleaned: list[str] = []
    for line in lines:
        stripped = line.rstrip()
        if stripped.strip() == "---":
            continue
        if is_markdown_table_separator(stripped):
            continue
        if stripped.strip().startswith("|"):
            cells = [cell.strip() for cell in stripped.strip().strip("|").split("|")]
            cleaned.append(" | ".join(cells))
            continue
        cleaned.append(strip_outer_markdown_emphasis(stripped) if stripped.strip() else "")

    while cleaned and not cleaned[0].strip():
        cleaned.pop(0)
    while cleaned and not cleaned[-1].strip():
        cleaned.pop()
    return "\n".join(cleaned)


def parse_front_page_markdown(path: Path) -> FrontPageCopy:
    text = normalize_newlines(path.read_text(encoding="utf-8")).strip()
    title_match = re.search(r"^#\s+(.+)$", text, flags=re.MULTILINE)
    edition_match = re.search(r"^\*\*(.+?)\*\*$", text, flags=re.MULTILINE)
    motto_match = re.search(r'^\*"(.+?)"\*$', text, flags=re.MULTILINE)
    if not title_match:
        raise ValueError(f"Could not find newspaper title in {path}")
    if not edition_match:
        raise ValueError(f"Could not find edition line in {path}")
    if not motto_match:
        raise ValueError(f"Could not find motto in {path}")

    story_matches = list(re.finditer(r"^##\s+([0-9]+)\.\s+(.+)$", text, flags=re.MULTILINE))
    stories: dict[int, Story] = {}
    for index, match in enumerate(story_matches):
        number = int(match.group(1))
        headline = match.group(2).strip()
        next_start = story_matches[index + 1].start() if index + 1 < len(story_matches) else len(text)
        block = text[match.end() : next_start].strip()
        lines = block.splitlines()

        label = ""
        body_start = 0
        for idx, line in enumerate(lines):
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith("*") and stripped.endswith("*"):
                label = strip_outer_markdown_emphasis(stripped)
                body_start = idx + 1
                break
        if not label:
            raise ValueError(f"Could not find section label for story {number}")

        body_text = clean_body_lines(lines[body_start:])
        render_text = (
            f"Headline:\n{headline}\n\n"
            f"Section label:\n{label}\n\n"
            f"Body copy:\n{body_text}"
        )
        stories[number] = Story(
            number=number,
            headline=headline,
            section_label=label,
            body_text=body_text,
            render_text=render_text,
        )

    missing = sorted(set(range(1, 11)) - set(stories))
    if missing:
        raise ValueError(f"Missing front-page stories: {missing}")

    return FrontPageCopy(
        title=title_match.group(1).strip(),
        edition_line=edition_match.group(1).strip(),
        motto=motto_match.group(1).strip(),
        stories=stories,
    )


def read_layout(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if "regions" not in data:
        raise ValueError(f"Layout has no regions: {path}")
    return data


def parse_size(value: str) -> tuple[int, int]:
    match = re.fullmatch(r"([1-9][0-9]*)x([1-9][0-9]*)", value)
    if not match:
        raise argparse.ArgumentTypeError("size must be WIDTHxHEIGHT")
    return int(match.group(1)), int(match.group(2))


def ceil_to_multiple(value: float, multiple: int = 16) -> int:
    return int(math.ceil(value / multiple) * multiple)


def choose_generation_size(target_width: int, target_height: int) -> tuple[int, int]:
    if target_width <= 0 or target_height <= 0:
        raise ValueError("target region dimensions must be positive")

    aspect = target_width / target_height
    effective_aspect = max(1 / GPT_IMAGE_2_MAX_RATIO, min(GPT_IMAGE_2_MAX_RATIO, aspect))

    if aspect > GPT_IMAGE_2_MAX_RATIO:
        width = float(target_width)
        height = width / GPT_IMAGE_2_MAX_RATIO
    elif aspect < 1 / GPT_IMAGE_2_MAX_RATIO:
        height = float(target_height)
        width = height / GPT_IMAGE_2_MAX_RATIO
    else:
        width = float(target_width)
        height = float(target_height)

    if width * height < GPT_IMAGE_2_MIN_PIXELS:
        factor = math.sqrt(GPT_IMAGE_2_MIN_PIXELS / (width * height))
        width *= factor
        height *= factor

    if max(width, height) > GPT_IMAGE_2_MAX_EDGE:
        factor = GPT_IMAGE_2_MAX_EDGE / max(width, height)
        width *= factor
        height *= factor

    if width * height > GPT_IMAGE_2_MAX_PIXELS:
        factor = math.sqrt(GPT_IMAGE_2_MAX_PIXELS / (width * height))
        width *= factor
        height *= factor

    width_i = max(16, ceil_to_multiple(width))
    height_i = max(16, ceil_to_multiple(height))

    # Rounding up can push us barely over the ratio or pixel limit; adjust conservatively.
    while max(width_i, height_i) / min(width_i, height_i) > GPT_IMAGE_2_MAX_RATIO:
        if width_i > height_i:
            height_i += 16
        else:
            width_i += 16
    while width_i * height_i < GPT_IMAGE_2_MIN_PIXELS:
        if effective_aspect >= 1:
            width_i += 16
        else:
            height_i += 16
    while width_i * height_i > GPT_IMAGE_2_MAX_PIXELS:
        if width_i >= height_i:
            width_i -= 16
        else:
            height_i -= 16

    if max(width_i, height_i) > GPT_IMAGE_2_MAX_EDGE:
        raise ValueError(f"Could not choose valid gpt-image-2 size for {target_width}x{target_height}")
    return width_i, height_i


def region_map(layout: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(region["id"]): region for region in layout["regions"]}


def union_bbox(*bboxes: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    return (
        min(bbox[0] for bbox in bboxes),
        min(bbox[1] for bbox in bboxes),
        max(bbox[2] for bbox in bboxes),
        max(bbox[3] for bbox in bboxes),
    )


def as_bbox(region: dict[str, Any]) -> tuple[int, int, int, int]:
    raw = region["bbox"]
    return int(raw[0]), int(raw[1]), int(raw[2]), int(raw[3])


def split_gossip_panel_bbox(
    bbox: tuple[int, int, int, int],
    *,
    gutter: int = GOSSIP_SPLIT_GUTTER,
) -> tuple[tuple[int, int, int, int], tuple[int, int, int, int]]:
    x0, y0, x1, y1 = bbox
    available_width = x1 - x0 - gutter
    if available_width <= 0:
        raise ValueError(f"Cannot split gossip panel bbox with gutter {gutter}: {bbox}")
    left_width = available_width // 2
    left = (x0, y0, x0 + left_width, y1)
    right = (x0 + left_width + gutter, y0, x1, y1)
    return left, right


def story_region_bbox(
    regions: dict[str, dict[str, Any]],
    region_id: str,
) -> tuple[int, int, int, int]:
    if region_id in {"story_08", "story_09"} and "gossip_panel" in regions:
        region = regions.get(region_id, {})
        if not region or region.get("parent") == "gossip_panel":
            story_08_bbox, story_09_bbox = split_gossip_panel_bbox(as_bbox(regions["gossip_panel"]))
            return story_08_bbox if region_id == "story_08" else story_09_bbox
    if region_id in regions:
        return as_bbox(regions[region_id])
    raise KeyError(region_id)


def story_region_description(
    regions: dict[str, dict[str, Any]],
    region_id: str,
) -> str:
    if region_id in {"story_08", "story_09"} and "gossip_panel" in regions:
        region = regions.get(region_id, {})
        if not region or region.get("parent") == "gossip_panel":
            return f"Derived {region_id} full story box split from the saved lower-right gossip panel geometry."
    if region_id in regions:
        return str(regions[region_id].get("description", ""))
    return ""


def build_units(layout: dict[str, Any]) -> list[GenerationUnit]:
    regions = region_map(layout)
    header_bbox = union_bbox(as_bbox(regions["masthead"]), as_bbox(regions["edition_strip"]))
    units = [
        GenerationUnit(
            id="header",
            role="header",
            bbox=header_bbox,
            description="Combined masthead and edition strip.",
        )
    ]
    for number in range(1, 10):
        region_id = f"story_{number:02d}"
        units.append(
            GenerationUnit(
                id=region_id,
                role="story",
                bbox=story_region_bbox(regions, region_id),
                story_numbers=(number,),
                description=story_region_description(regions, region_id),
            )
        )
    units.append(
        GenerationUnit(
            id="story_10",
            role="market",
            bbox=as_bbox(regions["story_10"]),
            story_numbers=(10,),
            description=str(regions["story_10"].get("description", "")),
        )
    )
    units.append(
        GenerationUnit(
            id="footer",
            role="footer",
            bbox=as_bbox(regions["footer"]),
            description=str(regions["footer"].get("description", "")),
        )
    )
    return units


def scale_bbox(
    bbox: tuple[int, int, int, int],
    source_size: tuple[int, int],
    target_size: tuple[int, int],
) -> tuple[int, int, int, int]:
    source_w, source_h = source_size
    target_w, target_h = target_size
    sx = target_w / source_w
    sy = target_h / source_h
    return (
        int(round(bbox[0] * sx)),
        int(round(bbox[1] * sy)),
        int(round(bbox[2] * sx)),
        int(round(bbox[3] * sy)),
    )


def default_out_dir(front_page_md: Path) -> Path:
    stem = front_page_md.stem.replace("gradient-news-observer-", "front-page-regions-")
    return DEFAULT_OUTPUT_ROOT / stem


def existing_paths(paths: list[Path]) -> list[Path]:
    return [path for path in paths if path.exists()]


def default_references() -> list[Path]:
    candidates = [
        DEFAULT_FULL_PAGE_REFERENCE,
        DEFAULT_UI_REFERENCE,
    ]
    return existing_paths(candidates)


def references_for_unit(unit: GenerationUnit, global_references: list[Path]) -> tuple[Path, ...]:
    refs = list(global_references)
    if unit.id == "header" and DEFAULT_MASTHEAD_REFERENCE.exists():
        insert_at = 1 if refs else 0
        refs.insert(insert_at, DEFAULT_MASTHEAD_REFERENCE)
    for raw in SHIP_REFERENCES.get(unit.id, ()):
        path = ROOT / raw
        if path.exists():
            refs.append(path)

    deduped: list[Path] = []
    seen: set[Path] = set()
    for ref in refs:
        resolved = ref.resolve()
        if resolved not in seen:
            seen.add(resolved)
            deduped.append(ref)
    return tuple(deduped)


def source_copy_for_unit(front_page: FrontPageCopy, unit: GenerationUnit) -> str:
    if unit.id == "header":
        return (
            "Masthead:\n"
            f"{front_page.title}\n\n"
            "Motto:\n"
            f"{front_page.motto}\n\n"
            "Edition line:\n"
            f"{front_page.edition_line}"
        )
    if unit.id == "footer":
        return "No readable text. Render only an ornamental bottom strip."

    if len(unit.story_numbers) != 1:
        raise ValueError(f"Unexpected story mapping for {unit.id}")
    return front_page.stories[unit.story_numbers[0]].render_text


def build_region_prompt(
    front_page: FrontPageCopy,
    unit: GenerationUnit,
    source_size: tuple[int, int],
    target_bbox: tuple[int, int, int, int],
    generation_size: tuple[int, int],
    references: tuple[Path, ...],
) -> str:
    target_w = target_bbox[2] - target_bbox[0]
    target_h = target_bbox[3] - target_bbox[1]
    reference_lines = [
        f"Image {index}: visual reference only, {path.as_posix()}"
        for index, path in enumerate(references, start=1)
    ]
    reference_text = "\n".join(reference_lines) if reference_lines else "No input images."
    art_direction = ART_DIRECTIONS.get(unit.id, "Retro-digital newspaper panel.")
    source_copy = source_copy_for_unit(front_page, unit)
    no_text_region = unit.id == "footer"
    source_copy_section = (
        "EMPTY. This region must contain no readable text; do not render the word EMPTY."
        if no_text_region
        else source_copy
    )

    return f"""Use case: infographic-diagram
Asset type: one independently rendered region for a high-resolution retro-digital newspaper front page

Input images:
{reference_text}

Primary request:
Create ONLY the {unit.id} region, not a complete front page. This output will be composited into a larger newspaper page.

Region geometry:
- Source layout box at 1024x1536 reference scale: {unit.bbox}
- Final composite target box: {target_w}x{target_h} px at position {target_bbox}
- Generation canvas: {generation_size[0]}x{generation_size[1]} px
- If this canvas is less wide than the final slot, keep important content in the center so a center-crop remains readable.

Visual style:
Retro-digital newspaper page inspired by the supplied generated Gradient News references: dark paper, cyan and bright luminous chartreuse-green ink, HUD borders, hex-map texture, scanlines, engraved-newsprint density, disciplined newspaper typography, and Gradient Bang ship art language. Use the full-page reference for color, layout rhythm, page texture, and in-context newspaper feel. Use any masthead/header reference only for nameplate craft and ornament, not for date, edition, motto, article, or table text. Use the Gradient Bang screenshot for UI language. Input images are references only; do not copy their old article text.

Headline typography house style:
- Every story-region headline, including straight-news, gossip, market, and small story boxes, must use the same headline font family.
- Use a bold condensed rectilinear terminal-display face: squared counters, straight sides, tall condensed capitals, monospaced/tech-news feel, crisp block terminals.
- Do not use serif, slab-serif, ornate Victorian, blackletter, script, handwritten, rounded, or mixed-font headline styles in story regions.
- The masthead/header region is the only region allowed to use ornate newspaper lettering. Section labels may use compact UI tag typography, but story headlines must remain the same house headline face across all story boxes.

Region art direction:
{art_direction}

Critical text contract:
1. The source copy is the complete and exclusive text inventory for this region.
2. Render source content exactly once in its natural order for this region.
3. Copy spelling, capitalization, punctuation, names, numbers, money amounts, dates, commas, apostrophes, and hyphens exactly.
4. Do not add invented readable labels, captions, sector numbers, slogans, ads, watermarks, signatures, player names, values, UI labels, chart labels, side-card labels, or decorative pseudo-text.
5. Do not render Markdown syntax characters used only for formatting, including #, ##, *, **, table separator rows, or horizontal rules.
6. If space is tight, reduce decorative art first. Do not omit, rewrite, abbreviate, or paraphrase source text.
7. Keep all text inside the panel border with safe margins.
8. All illustration areas must be silent art: ships, probes, sector maps, garrisons, charts, borders, and HUD motifs may appear, but they must not contain readable words, numbers, acronyms, labels, signs, screen text, or captions unless that exact text appears in the source copy.
9. For the footer region only: render no readable text at all.
10. Only the header region may render a newspaper masthead, newspaper nameplate, motto banner, edition strip, date banner, volume number, price, or publication identity. Non-header regions must not add any masthead-like text or page-header furniture.

Name-color styling contract:
HEADLINE = bright luminous chartreuse-green ink around #B7F23A, never cyan. This headline color rule overrides all name highlighting, even when the headline contains a player, pilot, ship, corporation, or entity name.
BODY COPY and TABLE CELLS = bright luminous chartreuse-green newspaper ink around #B7F23A, with player names, pilot names, ship names, named autonomous craft, corporation names, and named leaderboard entities from the Source copy highlighted in bright cyan ink (#62e8f2), while preserving exact spelling and capitalization.
Avoid mustard, amber, olive, brown, gold, dim yellow, or low-contrast yellow-green for readable text. Readable ordinary text should look lighter, brighter, and greener than aged newspaper ink.
ART/BORDER = cyan or acid-green, but no extra readable text.
Do not add the words player, pilot, ship, cyan, or name to the image unless they already appear in Source copy.

Source copy to render:
{source_copy_section}
"""


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


def plan_regions(
    *,
    front_page: FrontPageCopy,
    layout: dict[str, Any],
    front_page_md: Path,
    out_dir: Path,
    composite_size: tuple[int, int],
    global_references: list[Path],
    model: str,
    quality: str,
    selected_regions: set[str] | None,
    force: bool,
    dry_run: bool,
) -> tuple[list[PlannedRegion], dict[str, str]]:
    source_size = (
        int(layout["source_size"]["width"]),
        int(layout["source_size"]["height"]),
    )
    prompts_dir = out_dir / "prompts"
    regions_dir = out_dir / "regions"
    units = build_units(layout)
    if selected_regions:
        units = [unit for unit in units if unit.id in selected_regions]
    if not units:
        raise ValueError("No regions selected")

    planned: list[PlannedRegion] = []
    prompt_hashes: dict[str, str] = {}
    for unit in units:
        target_bbox = scale_bbox(unit.bbox, source_size, composite_size)
        target_w = target_bbox[2] - target_bbox[0]
        target_h = target_bbox[3] - target_bbox[1]
        generation_size = choose_generation_size(target_w, target_h)
        references = references_for_unit(unit, global_references)
        prompt = build_region_prompt(
            front_page=front_page,
            unit=unit,
            source_size=source_size,
            target_bbox=target_bbox,
            generation_size=generation_size,
            references=references,
        )
        prompt_path = prompts_dir / f"{unit.id}.txt"
        output_path = regions_dir / f"{unit.id}.png"
        prompt_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        prompt_bytes = prompt.encode("utf-8")
        prompt_path.write_bytes(prompt_bytes)
        prompt_hashes[unit.id] = sha256_bytes(prompt_bytes)

        cmd = [
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
        for ref in references:
            cmd.extend(["--image", str(ref)])
        if force:
            cmd.append("--force")
        if dry_run:
            cmd.append("--dry-run")

        planned.append(
            PlannedRegion(
                unit=unit,
                target_bbox=target_bbox,
                generation_size=generation_size,
                output=output_path,
                prompt=prompt_path,
                references=references,
                command=tuple(cmd),
            )
        )

    return planned, prompt_hashes


def write_metadata(
    *,
    metadata_path: Path,
    front_page_md: Path,
    layout_path: Path,
    layout: dict[str, Any],
    out_dir: Path,
    composite_path: Path,
    composite_size: tuple[int, int],
    model: str,
    quality: str,
    prompt_hashes: dict[str, str],
    planned: list[PlannedRegion],
    dry_run: bool,
    composite_only: bool,
) -> None:
    metadata = {
        "template_version": TEMPLATE_VERSION,
        "front_page_md": str(front_page_md),
        "front_page_md_sha256": sha256_file(front_page_md),
        "layout": str(layout_path),
        "layout_sha256": sha256_file(layout_path),
        "layout_source_image": layout.get("source_image"),
        "out_dir": str(out_dir),
        "composite": str(composite_path),
        "composite_size": {"width": composite_size[0], "height": composite_size[1]},
        "model": model,
        "quality": quality,
        "dry_run": dry_run,
        "composite_only": composite_only,
        "prompt_hashes": prompt_hashes,
        "regions": [
            {
                "id": item.unit.id,
                "role": item.unit.role,
                "stories": list(item.unit.story_numbers),
                "source_bbox": list(item.unit.bbox),
                "target_bbox": list(item.target_bbox),
                "generation_size": {
                    "width": item.generation_size[0],
                    "height": item.generation_size[1],
                },
                "prompt": str(item.prompt),
                "output": str(item.output),
                "references": [str(path) for path in item.references],
                "command": list(item.command),
            }
            for item in planned
        ],
        "notes": (
            "This experiment lets gpt-image-2 render all article text inside each region. "
            "The compositor only resizes/crops region images into fixed layout boxes; it does "
            "not perform deterministic text rendering."
        ),
    }
    metadata_path.parent.mkdir(parents=True, exist_ok=True)
    metadata_path.write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def generate_regions(planned: list[PlannedRegion], *, composite_only: bool) -> None:
    if composite_only:
        return
    env = env_with_api_key()
    for index, item in enumerate(planned, start=1):
        print(f"[{index}/{len(planned)}] Generating {item.unit.id}: {item.generation_size[0]}x{item.generation_size[1]}")
        print("Command:", " ".join(shlex.quote(part) for part in item.command))
        subprocess.run(item.command, check=True, env=env)


def composite_regions(
    planned: list[PlannedRegion],
    *,
    composite_path: Path,
    composite_size: tuple[int, int],
) -> None:
    try:
        from PIL import Image
    except ImportError as exc:
        raise SystemExit("Compositing requires Pillow. Run this via `uv run`.") from exc

    missing = [item.output for item in planned if not item.output.exists()]
    if missing:
        missing_text = "\n".join(str(path) for path in missing)
        raise SystemExit(f"Cannot composite; missing region images:\n{missing_text}")

    canvas = Image.new("RGB", composite_size, (3, 8, 9))
    for item in planned:
        x0, y0, x1, y1 = item.target_bbox
        target_size = (x1 - x0, y1 - y0)
        region = Image.open(item.output).convert("RGB")
        fitted = region.resize(target_size, resample=Image.Resampling.LANCZOS)
        canvas.paste(fitted, (x0, y0))

    composite_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(composite_path)
    print(f"Wrote composite: {composite_path}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate a Gradient News front page from independently rendered regions."
    )
    parser.add_argument("--front-page-md", type=Path, required=True, help="Newspaper story Markdown.")
    parser.add_argument("--layout", type=Path, default=DEFAULT_LAYOUT, help="Saved layout geometry JSON.")
    parser.add_argument("--out-dir", type=Path, help="Output directory for prompts, regions, and composite.")
    parser.add_argument("--out", type=Path, help="Composite PNG path. Defaults to <out-dir>/front-page-regional-composite.png.")
    parser.add_argument("--metadata-out", type=Path, help="Metadata JSON path. Defaults inside --out-dir.")
    parser.add_argument(
        "--reference",
        type=Path,
        action="append",
        help="Global visual reference image. Defaults to generated Gradient News full-page style reference and UI screenshot.",
    )
    parser.add_argument("--composite-size", type=parse_size, default=parse_size(DEFAULT_COMPOSITE_SIZE))
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--quality", default=DEFAULT_QUALITY)
    parser.add_argument("--region", action="append", help="Generate only this region id. May be repeated.")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--composite-only", action="store_true", help="Skip image generation and compose existing region PNGs.")
    return parser.parse_args(argv)


def run(argv: list[str]) -> int:
    args = parse_args(argv)
    if not args.front_page_md.exists():
        raise SystemExit(f"Missing front-page Markdown: {args.front_page_md}")
    if not args.layout.exists():
        raise SystemExit(f"Missing layout JSON: {args.layout}")
    if not IMAGE_GEN.exists():
        raise SystemExit(f"Missing image CLI: {IMAGE_GEN}")

    front_page = parse_front_page_markdown(args.front_page_md)
    layout = read_layout(args.layout)
    out_dir = args.out_dir or default_out_dir(args.front_page_md)
    out_dir.mkdir(parents=True, exist_ok=True)
    composite_path = args.out or (out_dir / "front-page-regional-composite.png")
    metadata_path = args.metadata_out or (
        out_dir / ("metadata-composite-only.json" if args.composite_only else "metadata.json")
    )
    selected_regions = set(args.region) if args.region else None
    global_references = args.reference if args.reference else default_references()
    missing_refs = [path for path in global_references if not path.exists()]
    if missing_refs:
        raise SystemExit(f"Missing reference image(s): {missing_refs}")

    planned, prompt_hashes = plan_regions(
        front_page=front_page,
        layout=layout,
        front_page_md=args.front_page_md,
        out_dir=out_dir,
        composite_size=args.composite_size,
        global_references=global_references,
        model=args.model,
        quality=args.quality,
        selected_regions=selected_regions,
        force=args.force,
        dry_run=args.dry_run,
    )
    write_metadata(
        metadata_path=metadata_path,
        front_page_md=args.front_page_md,
        layout_path=args.layout,
        layout=layout,
        out_dir=out_dir,
        composite_path=composite_path,
        composite_size=args.composite_size,
        model=args.model,
        quality=args.quality,
        prompt_hashes=prompt_hashes,
        planned=planned,
        dry_run=args.dry_run,
        composite_only=args.composite_only,
    )

    print("Front page Markdown:", args.front_page_md)
    print("Layout:", args.layout)
    print("Output directory:", out_dir)
    print("Metadata:", metadata_path)
    print("Regions:", ", ".join(item.unit.id for item in planned))

    generate_regions(planned, composite_only=args.composite_only)
    if not args.dry_run:
        composite_regions(planned, composite_path=composite_path, composite_size=args.composite_size)
    return 0


def main() -> int:
    return run(sys.argv[1:])


if __name__ == "__main__":
    raise SystemExit(main())
