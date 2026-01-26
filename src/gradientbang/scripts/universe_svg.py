#!/usr/bin/env -S uv run python
"""Generate an SVG map of the universe from world-data JSON."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from gradientbang.utils.config import get_world_data_path


def _load_json(path: Path) -> Dict:
    return json.loads(path.read_text())


def _hex_path_unit() -> str:
    points: List[str] = []
    for i in range(6):
        angle = math.radians(60 * i)
        x = math.cos(angle)
        y = math.sin(angle)
        points.append(f"{x:.4f},{y:.4f}")
    return "M " + " L ".join(points) + " Z"


def _compute_scale(
    positions: Sequence[Tuple[float, float]],
    width: float,
    height: float,
    margin: float,
) -> Tuple[float, float, float, float, float]:
    xs = [p[0] for p in positions]
    ys = [p[1] for p in positions]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    span_x = max_x - min_x or 1.0
    span_y = max_y - min_y or 1.0
    scale = min((width - 2 * margin) / span_x, (height - 2 * margin) / span_y)
    return min_x, max_x, min_y, max_y, scale


def _project(
    x: float,
    y: float,
    min_x: float,
    max_y: float,
    scale: float,
    margin: float,
) -> Tuple[float, float]:
    px = margin + (x - min_x) * scale
    # Flip y for conventional top-down orientation
    py = margin + (max_y - y) * scale
    return px, py


def _median(values: List[float]) -> float:
    if not values:
        return 1.0
    values.sort()
    mid = len(values) // 2
    if len(values) % 2 == 0:
        return (values[mid - 1] + values[mid]) / 2
    return values[mid]


def _safe_int(value: object) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate an SVG map from world-data/universe.json."
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=None,
        help="Path to universe.json or directory containing it",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("artifacts/universe-map.svg"),
        help="Output SVG path (default: artifacts/universe-map.svg)",
    )
    parser.add_argument("--width", type=int, default=3200)
    parser.add_argument("--height", type=int, default=2400)
    parser.add_argument("--margin", type=int, default=80)
    parser.add_argument("--no-edges", action="store_true")
    parser.add_argument("--legend", action="store_true")
    parser.add_argument(
        "--labels",
        action="store_true",
        help="Include sector number labels (default: off)",
    )
    args = parser.parse_args()

    data_path = args.data_dir or get_world_data_path()
    universe_path = data_path / "universe.json" if data_path.is_dir() else data_path
    universe = _load_json(universe_path)

    sectors = universe.get("sectors", [])
    positions: Dict[int, Tuple[float, float]] = {}
    for sector in sectors:
        sector_id = _safe_int(sector.get("id"))
        pos = sector.get("position") or {}
        if sector_id is None:
            continue
        positions[sector_id] = (float(pos.get("x", 0)), float(pos.get("y", 0)))

    if not positions:
        raise SystemExit("No sector positions found in universe.json")

    pos_values = list(positions.values())
    min_x, max_x, min_y, max_y, scale = _compute_scale(
        pos_values, args.width, args.height, args.margin
    )

    adjacency_edges: List[Tuple[int, int]] = []
    for sector in sectors:
        source_id = _safe_int(sector.get("id"))
        if source_id is None or source_id not in positions:
            continue
        sx, sy = positions[source_id]
        for warp in sector.get("warps", []):
            dest_id = _safe_int(warp.get("to"))
            if dest_id is None or dest_id not in positions:
                continue
            adjacency_edges.append((source_id, dest_id))

    # Use a fixed hex radius in grid units to avoid overlaps.
    hex_radius = scale * 0.45
    port_radius = hex_radius * 0.33
    mega_radius = hex_radius * 0.55

    meta = universe.get("meta", {})
    fedspace = set(
        meta.get("fedspace_sectors") or []
    )
    mega_ports = set(
        meta.get("mega_port_sectors") or []
    )

    ports: Dict[int, Dict] = {}
    for sector in sectors:
        sector_id = _safe_int(sector.get("id"))
        if sector_id is None:
            continue
        port_data = sector.get("port")
        if port_data:
            ports[sector_id] = port_data
            if port_data.get("is_mega"):
                mega_ports.add(sector_id)

    args.output.parent.mkdir(parents=True, exist_ok=True)

    hex_path = _hex_path_unit()

    svg_lines: List[str] = []
    svg_lines.append(
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'width="{args.width}" height="{args.height}" '
        f'viewBox="0 0 {args.width} {args.height}" '
        f'role="img" aria-label="Universe map">'
    )
    svg_lines.append("<defs>")
    svg_lines.append(
        '<marker id="arrow" markerWidth="4" markerHeight="4" refX="3" refY="2" '
        'orient="auto" markerUnits="strokeWidth">'
        '<path d="M0,0 L4,2 L0,4 Z" fill="var(--edge)" />'
        "</marker>"
    )
    svg_lines.append(f'<path id="hex" d="{hex_path}" />')
    svg_lines.append("</defs>")

    svg_lines.append(
        "<style>"
        ":root {"
        "--bg:#07090c;"
        "--edge:#1c2a33;"
        "--sector-fill:#0c1217;"
        "--sector-stroke:#1f2a33;"
        "--fedspace-fill:#0c2433;"
        "--fedspace-stroke:#5aa2d8;"
        "--port:#66f3a3;"
        "--port-stroke:#1e5a3c;"
        "--mega:#ffd37b;"
        "--mega-stroke:#b8861f;"
        "--label:#a7b4bf;"
        "--label-halo:#05070a;"
        "--text:#cbd5e1;"
        "}"
        ".bg{fill:var(--bg);}"
        ".edge{stroke:var(--edge);stroke-opacity:.25;stroke-width:0.5;stroke-linecap:round;}"
        ".sector{fill:var(--sector-fill);stroke:var(--sector-stroke);stroke-width:0.6;"
        "vector-effect:non-scaling-stroke;}"
        ".fedspace{fill:var(--fedspace-fill);stroke:var(--fedspace-stroke);stroke-width:0.8;"
        "vector-effect:non-scaling-stroke;}"
        ".port{fill:var(--port);stroke:var(--port-stroke);stroke-width:0.9;}"
        ".mega{fill:var(--mega);stroke:var(--mega-stroke);stroke-width:1.2;}"
        ".label{fill:var(--label);font-size:9px;letter-spacing:0.2px;"
        "font-family:Rajdhani,Space Grotesk,Segoe UI,ui-sans-serif,system-ui;"
        "paint-order:stroke;stroke:var(--label-halo);stroke-width:2;"
        "stroke-linejoin:round;opacity:.8;}"
        ".legend{fill:var(--text);font-family:Rajdhani,Space Grotesk,Segoe UI,ui-sans-serif,system-ui;}"
        "</style>"
    )

    svg_lines.append(f'<rect class="bg" x="0" y="0" width="{args.width}" height="{args.height}" />')

    # Edges
    if not args.no_edges:
        svg_lines.append('<g class="edges">')
        for source_id, dest_id in adjacency_edges:
            sx, sy = positions[source_id]
            tx, ty = positions[dest_id]
            psx, psy = _project(sx, sy, min_x, max_y, scale, args.margin)
            ptx, pty = _project(tx, ty, min_x, max_y, scale, args.margin)
            dx = ptx - psx
            dy = pty - psy
            length = math.hypot(dx, dy)
            if length < 1e-6:
                continue
            shrink = hex_radius * 0.85
            ux, uy = dx / length, dy / length
            start_x = psx + ux * shrink
            start_y = psy + uy * shrink
            end_x = ptx - ux * shrink
            end_y = pty - uy * shrink
            svg_lines.append(
                f'<line class="edge" x1="{start_x:.2f}" y1="{start_y:.2f}" '
                f'x2="{end_x:.2f}" y2="{end_y:.2f}" marker-end="url(#arrow)" />'
            )
        svg_lines.append("</g>")

    # Sectors
    svg_lines.append('<g class="sectors">')
    for sector_id, (x, y) in positions.items():
        px, py = _project(x, y, min_x, max_y, scale, args.margin)
        cls = "fedspace" if sector_id in fedspace else "sector"
        svg_lines.append(
            f'<use href="#hex" class="{cls}" transform="translate({px:.2f},{py:.2f}) scale({hex_radius:.2f})" />'
        )
    svg_lines.append("</g>")

    # Ports & mega-ports
    svg_lines.append('<g class="ports">')
    for sector_id, (x, y) in positions.items():
        if sector_id not in ports:
            continue
        px, py = _project(x, y, min_x, max_y, scale, args.margin)
        if sector_id in mega_ports:
            svg_lines.append(
                f'<circle class="mega" cx="{px:.2f}" cy="{py:.2f}" r="{mega_radius:.2f}" />'
            )
        svg_lines.append(
            f'<circle class="port" cx="{px:.2f}" cy="{py:.2f}" r="{port_radius:.2f}" />'
        )
    svg_lines.append("</g>")

    if args.labels:
        # Sector labels
        label_dx = hex_radius * 0.6
        label_dy = -hex_radius * 0.35
        svg_lines.append('<g class="labels">')
        for sector_id, (x, y) in positions.items():
            px, py = _project(x, y, min_x, max_y, scale, args.margin)
            lx = px + label_dx
            ly = py + label_dy
            svg_lines.append(
                f'<text class="label" x="{lx:.2f}" y="{ly:.2f}">{sector_id}</text>'
            )
        svg_lines.append("</g>")

    if args.legend:
        legend_x = args.margin
        legend_y = args.margin * 0.6
        svg_lines.append('<g class="legend">')
        svg_lines.append(
            f'<rect x="{legend_x - 10}" y="{legend_y - 22}" width="240" height="88" '
            'fill="rgba(11,15,22,0.75)" stroke="var(--sector-stroke)" />'
        )
        svg_lines.append(
            f'<use href="#hex" class="sector" transform="translate({legend_x:.2f},{legend_y:.2f}) scale({hex_radius:.2f})" />'
        )
        svg_lines.append(
            f'<text x="{legend_x + 18}" y="{legend_y + 4}" class="legend">Standard sector</text>'
        )
        svg_lines.append(
            f'<use href="#hex" class="fedspace" transform="translate({legend_x:.2f},{legend_y + 26:.2f}) scale({hex_radius:.2f})" />'
        )
        svg_lines.append(
            f'<text x="{legend_x + 18}" y="{legend_y + 30}" class="legend">Federation Space</text>'
        )
        svg_lines.append(
            f'<circle class="port" cx="{legend_x:.2f}" cy="{legend_y + 52:.2f}" r="{port_radius:.2f}" />'
        )
        svg_lines.append(
            f'<text x="{legend_x + 18}" y="{legend_y + 56}" class="legend">Port</text>'
        )
        svg_lines.append(
            f'<circle class="mega" cx="{legend_x:.2f}" cy="{legend_y + 74:.2f}" r="{mega_radius:.2f}" />'
        )
        svg_lines.append(
            f'<text x="{legend_x + 18}" y="{legend_y + 78}" class="legend">Mega-port</text>'
        )
        svg_lines.append("</g>")

    svg_lines.append("</svg>")

    args.output.write_text("\n".join(svg_lines) + "\n")
    print(f"Wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
