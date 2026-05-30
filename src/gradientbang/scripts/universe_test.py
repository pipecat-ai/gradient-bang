#!/usr/bin/env -S uv run python
"""Validate generated universe JSON connectivity and warp metadata."""

import argparse
import json
import sys
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import networkx as nx

from gradientbang.config import settings

DEFAULT_UNIVERSE_PATH = Path(settings.GRADIENTBANG_WORLD_DATA_DIR) / "universe.json"
TwoWayIssue = Tuple[
    str,
    Tuple[int, int],
    Optional[Tuple[int, int]],
    Optional[bool],
    Optional[bool],
]


@dataclass(frozen=True)
class UniverseValidationReport:
    sector_count: int
    warp_count: int
    start_sector: int
    average_out_degree: float
    average_in_degree: float
    two_way_warps: int
    one_way_warps: int
    strongly_connected: bool
    scc_sizes: List[int]
    dead_ends: List[int]
    unreachable_from_start: List[int]
    trap_clusters: List[List[int]]
    isolated_clusters: List[List[int]]
    two_way_inconsistencies: List[TwoWayIssue]

    @property
    def passed(self) -> bool:
        return (
            self.strongly_connected
            and not self.dead_ends
            and not self.unreachable_from_start
            and not self.trap_clusters
            and not self.isolated_clusters
            and not self.two_way_inconsistencies
        )

    @property
    def two_way_ratio(self) -> float:
        total = self.two_way_warps + self.one_way_warps
        return self.two_way_warps / total if total else 0.0


def load_universe_data(path: Path) -> Dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"Missing universe JSON: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def build_graph(universe_data: Dict[str, Any]) -> nx.DiGraph:
    graph = nx.DiGraph()
    for sector in _sectors(universe_data):
        graph.add_node(sector["id"])
    for sector in _sectors(universe_data):
        for warp in sector.get("warps", []):
            graph.add_edge(sector["id"], warp["to"])
    return graph


def validate_universe_file(path: Path) -> UniverseValidationReport:
    return validate_universe_data(load_universe_data(path))


def validate_universe_data(
    universe_data: Dict[str, Any],
) -> UniverseValidationReport:
    sectors = _sectors(universe_data)
    if not sectors:
        raise ValueError("universe JSON contains no sectors")

    graph = build_graph(universe_data)
    start_sector = _start_sector(universe_data)
    two_way_warps, one_way_warps = _warp_counts(universe_data)
    scc_sizes = sorted(
        (len(component) for component in nx.strongly_connected_components(graph)),
        reverse=True,
    )

    return UniverseValidationReport(
        sector_count=graph.number_of_nodes(),
        warp_count=graph.number_of_edges(),
        start_sector=start_sector,
        average_out_degree=_average_degree(graph, incoming=False),
        average_in_degree=_average_degree(graph, incoming=True),
        two_way_warps=two_way_warps,
        one_way_warps=one_way_warps,
        strongly_connected=nx.is_strongly_connected(graph),
        scc_sizes=scc_sizes,
        dead_ends=find_dead_ends(universe_data),
        unreachable_from_start=find_unreachable_from_start(graph, start_sector),
        trap_clusters=find_trap_clusters(graph),
        isolated_clusters=find_isolated_clusters(graph),
        two_way_inconsistencies=find_two_way_inconsistencies(universe_data),
    )


def format_validation_report(
    report: UniverseValidationReport,
    *,
    source: Optional[Path] = None,
    detail_limit: int = 10,
) -> str:
    lines = []
    title = "Universe validation"
    if source is not None:
        title = f"{title}: {source}"
    lines.append(title)
    lines.append(
        f"sectors={report.sector_count} warps={report.warp_count} "
        f"start_sector={report.start_sector}"
    )
    lines.append(
        f"avg_out={report.average_out_degree:.2f} "
        f"avg_in={report.average_in_degree:.2f} "
        f"two_way={report.two_way_warps} one_way={report.one_way_warps} "
        f"two_way_ratio={report.two_way_ratio:.1%}"
    )

    checks = [
        ("dead ends", not report.dead_ends, report.dead_ends),
        (
            "strong connectivity",
            report.strongly_connected,
            report.scc_sizes,
        ),
        (
            f"reachable from sector {report.start_sector}",
            not report.unreachable_from_start,
            report.unreachable_from_start,
        ),
        ("trap clusters", not report.trap_clusters, report.trap_clusters),
        (
            "isolated clusters",
            not report.isolated_clusters,
            report.isolated_clusters,
        ),
        (
            "two_way flags",
            not report.two_way_inconsistencies,
            report.two_way_inconsistencies,
        ),
    ]
    for name, ok, detail in checks:
        status = "PASS" if ok else "FAIL"
        line = f"{status}: {name}"
        if not ok:
            line = f"{line}: {_sample(detail, detail_limit)}"
        lines.append(line)

    lines.append("result=PASS" if report.passed else "result=FAIL")
    return "\n".join(lines)


def find_two_way_inconsistencies(
    universe_data: Dict[str, Any],
) -> List[TwoWayIssue]:
    edges = _map_edges(universe_data)
    problems = []
    checked_pairs = set()
    for (u, v), _info_uv in edges.items():
        pair = (min(u, v), max(u, v))
        if pair in checked_pairs:
            continue
        checked_pairs.add(pair)

        uv = (u, v)
        vu = (v, u)
        has_uv = uv in edges
        has_vu = vu in edges
        flag_uv = edges[uv].get("two_way") if has_uv else None
        flag_vu = edges[vu].get("two_way") if has_vu else None

        if has_uv and has_vu and not (flag_uv and flag_vu):
            problems.append(("mutual_edges_not_flagged_two_way", uv, vu, flag_uv, flag_vu))
        elif has_uv and not has_vu and flag_uv:
            problems.append(("one_way_flagged_two_way", uv, None, flag_uv, None))
        elif has_vu and not has_uv and flag_vu:
            problems.append(("one_way_flagged_two_way", vu, None, flag_vu, None))
    return problems


def find_dead_ends(universe_data: Dict[str, Any]) -> List[int]:
    return [sector["id"] for sector in _sectors(universe_data) if not sector.get("warps")]


def find_unreachable_from_start(
    graph: nx.DiGraph,
    start_sector: int = 0,
) -> List[int]:
    if start_sector not in graph:
        return sorted(graph.nodes())

    reachable = set()
    queue = deque([start_sector])
    while queue:
        current = queue.popleft()
        if current in reachable:
            continue
        reachable.add(current)
        for neighbor in graph.successors(current):
            if neighbor not in reachable:
                queue.append(neighbor)
    return sorted(set(graph.nodes()) - reachable)


def find_trap_clusters(graph: nx.DiGraph) -> List[List[int]]:
    sccs = list(nx.strongly_connected_components(graph))
    condensation = nx.condensation(graph, sccs)
    traps = []
    for scc_idx, scc_nodes in enumerate(sccs):
        if condensation.in_degree(scc_idx) > 0 and condensation.out_degree(scc_idx) == 0:
            traps.append(sorted(scc_nodes))
    return traps


def find_isolated_clusters(graph: nx.DiGraph) -> List[List[int]]:
    if nx.is_strongly_connected(graph):
        return []

    isolated = []
    for component in nx.weakly_connected_components(graph):
        external_edges = 0
        for node in component:
            external_edges += sum(1 for pred in graph.predecessors(node) if pred not in component)
            external_edges += sum(1 for succ in graph.successors(node) if succ not in component)
        if external_edges == 0:
            isolated.append(sorted(component))
    return isolated


def check_strong_connectivity(graph: nx.DiGraph) -> bool:
    return nx.is_strongly_connected(graph)


def analyze_universe(filepath: Path) -> bool:
    report = validate_universe_file(filepath)
    print(format_validation_report(report, source=filepath))
    return report.passed


def _sectors(universe_data: Dict[str, Any]) -> List[Dict[str, Any]]:
    sectors = universe_data.get("sectors")
    if not isinstance(sectors, list):
        raise ValueError("universe JSON missing required list: sectors")
    return sectors


def _map_edges(universe_data: Dict[str, Any]) -> Dict[Tuple[int, int], Dict[str, Any]]:
    edges = {}
    for sector in _sectors(universe_data):
        source = sector["id"]
        for warp in sector.get("warps", []):
            edges[(source, warp["to"])] = warp
    return edges


def _start_sector(universe_data: Dict[str, Any]) -> int:
    meta = universe_data.get("meta", {})
    mega_ports = meta.get("mega_port_sectors")
    if not mega_ports and meta.get("mega_port_sector") is not None:
        mega_ports = [meta["mega_port_sector"]]
    if isinstance(mega_ports, list):
        for sector_id in mega_ports:
            if isinstance(sector_id, int):
                return sector_id
    return 0


def _warp_counts(universe_data: Dict[str, Any]) -> Tuple[int, int]:
    two_way = 0
    one_way = 0
    for sector in _sectors(universe_data):
        for warp in sector.get("warps", []):
            if warp.get("two_way"):
                two_way += 1
            else:
                one_way += 1
    return two_way, one_way


def _average_degree(graph: nx.DiGraph, *, incoming: bool) -> float:
    if graph.number_of_nodes() == 0:
        return 0.0
    degrees = graph.in_degree() if incoming else graph.out_degree()
    return sum(degree for _node, degree in degrees) / graph.number_of_nodes()


def _sample(value: Any, limit: int) -> str:
    if isinstance(value, list):
        suffix = "" if len(value) <= limit else f" ... (+{len(value) - limit} more)"
        return f"{value[:limit]}{suffix}"
    return str(value)


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate generated universe JSON")
    parser.add_argument(
        "path",
        type=Path,
        nargs="?",
        default=DEFAULT_UNIVERSE_PATH,
        help="Path to universe.json (default: GRADIENTBANG_WORLD_DATA_DIR/universe.json)",
    )
    args = parser.parse_args()

    try:
        report = validate_universe_file(args.path)
    except Exception as exc:
        print(f"Universe validation failed to run: {exc}", file=sys.stderr)
        return 2

    print(format_validation_report(report, source=args.path))
    return 0 if report.passed else 1


if __name__ == "__main__":
    sys.exit(main())
