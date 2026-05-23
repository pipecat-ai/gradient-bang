#!/usr/bin/env -S uv run python
"""Generate a spatial universe JSON for Gradient Bang.

The output is a directed sector graph. Each sector has a stable integer id,
snapped x/y map coordinates, a region id, outbound warp links, optional port
inventory, an empty planets slot, and future-facing scene config. Metadata
records the seed, region labels, FedSpace core, mega-port hubs, pricing bands,
and port inventory defaults used by the Supabase loader.

Topology is built from a sparse Delaunay graph, a protected two-way MST
backbone, light one-way warp variation, and a connected Federation Space core.
"""

import argparse
import heapq
import json
import math
import random
import sys
from collections import deque
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

import networkx as nx
import numpy as np
from loguru import logger
from scipy.spatial import Delaunay

from gradientbang.config import settings
from gradientbang.scripts.universe_test import (
    format_validation_report,
    validate_universe_data,
)
from gradientbang.scripts.universe_scene_gen import generate_scene_variant

Position = Tuple[float, float]
PositionMap = Dict[int, Position]
WarpMap = Dict[int, Set[int]]
PortClassMap = Dict[int, int]

FEDSPACE_SECTOR_COUNT = 75  # Sectors in the connected Federation Space core.
FEDSPACE_REGION_NAME = "Federation Space"  # Human label for the safe core.
NEUTRAL_REGION_NAME = "Neutral"  # Human label for ordinary space.
FEDSPACE_REGION_ID = 1  # Region id assigned to FedSpace sectors.
NEUTRAL_REGION_ID = 0  # Region id assigned to non-FedSpace sectors.

REGIONS = [  # Region metadata; list position must match region id.
    {"name": NEUTRAL_REGION_NAME},
    {"name": FEDSPACE_REGION_NAME},
]

MAX_DELAUNAY_EDGE_LENGTH = 3.5  # Long candidate warp edges are discarded.

BASE_PORT_DENSITY = 0.40  # Baseline fraction of sectors that can host ports.
INITIAL_PORT_BUILD_RATE = 0.95  # Startup buildout multiplier for ports.
PORT_PERCENTAGE = BASE_PORT_DENSITY * INITIAL_PORT_BUILD_RATE  # Effective port density.

MEGA_PORT_STOCK_MULTIPLIER = 10  # Mega-port inventory capacity multiplier.
MEGA_PORT_COUNT = 3  # Number of FedSpace mega-port hubs.

MIN_WARPS_PER_SECTOR = 1  # Minimum outgoing links before connectivity repair.
MAX_WARPS_PER_SECTOR = 2  # Target random links per sector before repair/capping.
TWO_WAY_PROBABILITY_ADJACENT = 0.7  # Two-way chance for nearest-neighbor links.
TWO_WAY_PROBABILITY_DISTANT = 0.3  # Two-way chance for longer retained links.
DEGREE_CAP = 6  # Maximum outgoing links after protected edges are preserved.

ENSURE_COMPLEMENTARY_PAIRS = True  # Tune port classes toward local trade pairs.
COMPLEMENTARY_PAIR_RADIUS = 2  # Hop radius used to search for trade pairs.
COMPLEMENTARY_PAIR_COVERAGE = 0.70  # Desired share of ports with nearby complements.
MAX_PAIR_TUNING_PASSES = 2  # Max passes for complementary port tuning.

SELL_MIN, SELL_MAX = 0.75, 1.10  # Sell price band metadata.
BUY_MIN, BUY_MAX = 0.90, 1.30  # Buy price band metadata.

PORT_MIN_CAP = 1000  # Minimum regular-port commodity capacity.
PORT_MAX_CAP = 10000  # Maximum regular-port commodity capacity.

PORT_STARTING_FILL_SELL = 1.0  # Starting stock fill for seller commodities.
PORT_STARTING_FILL_BUY = 0.0  # Starting stock fill for buyer commodities.
REGEN_FRACTION_STOCK = 0.25  # Stock replenishment fraction metadata.
REGEN_FRACTION_DEMAND = 0.25  # Demand recovery fraction metadata.

COM_LONG = {  # Short commodity codes to database/client names.
    "QF": "quantum_foam",
    "RO": "retro_organics",
    "NS": "neuro_symbolics",
}
COMMODITY_CODES = tuple(COM_LONG)  # Stable iteration order for port classes.

CLASS_DEFS = {  # Port class id to buy/sell pattern for QF/RO/NS.
    1: "BBS",
    2: "BSB",
    3: "SBB",
    4: "SSB",
    5: "SBS",
    6: "BSS",
    7: "SSS",
    8: "BBB",
}
CODE_TO_CLASS = {code: c for c, code in CLASS_DEFS.items()}  # Pattern to class id.


def generate_hex_grid(width: int, height: int) -> List[Position]:
    """Generate snapped hex-grid positions."""
    positions = []
    for row in range(height):
        for col in range(width):
            x = col * 1.5
            y = row * math.sqrt(3)
            if col % 2 == 1:
                y += math.sqrt(3) / 2
            positions.append((round(x), round(y)))
    return positions


def euclidean_distance(p1: Position, p2: Position) -> float:
    return math.sqrt((p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2)


def hex_distance(p1: Position, p2: Position) -> float:
    return euclidean_distance(p1, p2)


def place_sectors_uniform(
    hex_positions: List[Position],
    sector_count: int,
) -> PositionMap:
    """Place sectors uniformly across the hex grid, snapped to hex positions."""
    if sector_count > len(hex_positions):
        raise ValueError(
            f"sector_count ({sector_count}) exceeds available hex positions ({len(hex_positions)})."
        )

    selected_hexes = random.sample(hex_positions, sector_count)
    return {sector_id: selected_hexes[sector_id] for sector_id in range(sector_count)}


def generate_connections(positions: PositionMap) -> WarpMap:
    """Generate connections with spatial awareness and minimal crossings."""
    warps = {s: set() for s in positions.keys()}
    sectors = list(positions.keys())

    if len(sectors) < 3:
        for i in range(len(sectors) - 1):
            s1, s2 = sectors[i], sectors[i + 1]
            warps[s1].add(s2)
            warps[s2].add(s1)
        return warps

    pts = np.array([positions[s] for s in sectors])
    tri = Delaunay(pts)

    edges = set()
    for simplex in tri.simplices:
        for i in range(3):
            a_idx, b_idx = simplex[i], simplex[(i + 1) % 3]
            a, b = sectors[a_idx], sectors[b_idx]
            if a > b:
                a, b = b, a
            edges.add((a, b))

    for s1, s2 in edges:
        dist = hex_distance(positions[s1], positions[s2])
        if dist > MAX_DELAUNAY_EDGE_LENGTH:
            continue

        if dist <= 1.5:
            if random.random() < TWO_WAY_PROBABILITY_ADJACENT:
                warps[s1].add(s2)
                warps[s2].add(s1)
            else:
                if random.random() < 0.5:
                    warps[s1].add(s2)
                else:
                    warps[s2].add(s1)
        else:
            if random.random() < TWO_WAY_PROBABILITY_DISTANT:
                warps[s1].add(s2)
                warps[s2].add(s1)
            else:
                if random.random() < 0.5:
                    warps[s1].add(s2)
                else:
                    warps[s2].add(s1)

    backbone_edges = build_backbone_edges(positions)
    for s1, s2 in backbone_edges:
        warps[s1].add(s2)
        warps[s2].add(s1)

    ensure_connectivity(warps, positions)

    protected_pairs = set(backbone_edges)
    protected_pairs.update(collect_two_way_pairs(warps))
    cap_degrees(warps, positions, protected_undirected_edges=protected_pairs)

    return warps


def build_backbone_edges(
    positions: PositionMap,
) -> Set[Tuple[int, int]]:
    """Build two-way MST backbone edges over the Delaunay graph."""
    sectors = list(positions.keys())
    if len(sectors) <= 1:
        return set()

    pts = np.array([positions[s] for s in sectors])
    tri = Delaunay(pts)

    edges = set()
    for simplex in tri.simplices:
        for i in range(3):
            a_idx, b_idx = simplex[i], simplex[(i + 1) % 3]
            a, b = sectors[a_idx], sectors[b_idx]
            if a > b:
                a, b = b, a
            edges.add((a, b))

    G = nx.Graph()
    G.add_nodes_from(sectors)
    for a, b in edges:
        dist = euclidean_distance(positions[a], positions[b])
        G.add_edge(a, b, weight=dist)

    mst = nx.minimum_spanning_tree(G, algorithm="kruskal")
    backbone = set()
    for a, b in mst.edges():
        if a > b:
            a, b = b, a
        backbone.add((a, b))
    return backbone


def ensure_connectivity(
    warps: WarpMap,
    positions: PositionMap,
) -> None:
    """Ensure weak connectivity and soften obvious directed traps."""
    sectors = list(positions.keys())

    for s in sectors:
        out_degree = len(warps[s])

        if out_degree < MIN_WARPS_PER_SECTOR:
            candidates = [
                (hex_distance(positions[s], positions[other]), other)
                for other in sectors
                if other != s and other not in warps[s]
            ]
            candidates.sort()

            for _, other in candidates[: MIN_WARPS_PER_SECTOR - out_degree]:
                warps[s].add(other)

    G_undirected = nx.Graph()
    G_undirected.add_nodes_from(sectors)

    for s in sectors:
        for target in warps.get(s, set()):
            G_undirected.add_edge(s, target)

    components = list(nx.connected_components(G_undirected))

    if len(components) > 1:
        logger.info("Connecting {} disconnected components.", len(components))

        components.sort(key=len, reverse=True)
        main_component = components[0]

        for comp_idx, component in enumerate(components[1:], 1):
            best_dist = float("inf")
            best_pair = None

            for s1 in main_component:
                for s2 in component:
                    dist = hex_distance(positions[s1], positions[s2])
                    if dist < best_dist:
                        best_dist = dist
                        best_pair = (s1, s2)

            if best_pair and best_dist <= MAX_DELAUNAY_EDGE_LENGTH * 1.5:
                s1, s2 = best_pair
                warps[s1].add(s2)
                warps[s2].add(s1)
                logger.info(
                    "Connected component {} ({} sectors) at distance {:.1f}.",
                    comp_idx,
                    len(component),
                    best_dist,
                )
                main_component = main_component.union(component)
            else:
                logger.warning(
                    "Component {} too far to connect (distance {:.1f}).",
                    comp_idx,
                    best_dist,
                )

    logger.info("Checking for accessibility issues...")

    G_directed = nx.DiGraph()
    G_directed.add_nodes_from(sectors)
    for s in sectors:
        for target in warps.get(s, set()):
            G_directed.add_edge(s, target)

    problem_sectors = []
    for sector in sectors:
        reachable = nx.descendants(G_directed, sector)
        if len(reachable) < len(sectors) * 0.5:
            problem_sectors.append(sector)

    if problem_sectors:
        logger.info("Found {} sectors with limited reachability.", len(problem_sectors))

        upgrades_made = 0
        for sector in problem_sectors[:100]:
            for target in list(warps.get(sector, set())):
                if sector not in warps.get(target, set()):
                    dist = hex_distance(positions[sector], positions[target])
                    if dist <= MAX_DELAUNAY_EDGE_LENGTH:
                        warps[target].add(sector)
                        upgrades_made += 1
                        break

        if upgrades_made > 0:
            logger.info("Upgraded {} connections to two-way.", upgrades_made)


def collect_two_way_pairs(warps: WarpMap) -> Set[Tuple[int, int]]:
    """Collect mutual links as undirected pairs."""
    pairs: Set[Tuple[int, int]] = set()
    for s, neighbors in warps.items():
        for t in neighbors:
            if s in warps.get(t, set()):
                a, b = (s, t) if s < t else (t, s)
                pairs.add((a, b))
    return pairs


def cap_degrees(
    warps: WarpMap,
    positions: PositionMap,
    protected_undirected_edges: Optional[Set[Tuple[int, int]]] = None,
) -> None:
    """Cap degree by dropping long non-protected edges."""
    protected_by_node: Dict[int, Set[int]] = {}
    if protected_undirected_edges:
        for a, b in protected_undirected_edges:
            protected_by_node.setdefault(a, set()).add(b)
            protected_by_node.setdefault(b, set()).add(a)

    for s, targets in warps.items():
        if len(targets) <= DEGREE_CAP:
            continue

        protected_neighbors = protected_by_node.get(s, set())
        sorted_targets = sorted(
            targets,
            key=lambda t: hex_distance(positions[s], positions[t]),
        )
        kept: List[int] = []
        kept_set: Set[int] = set()
        for t in sorted_targets:
            if t in protected_neighbors:
                kept.append(t)
                kept_set.add(t)
        cap = max(DEGREE_CAP, len(kept))
        for t in sorted_targets:
            if len(kept) >= cap:
                break
            if t in kept_set:
                continue
            kept.append(t)
            kept_set.add(t)
        warps[s] = set(kept)


def build_adjacency_from_warps(
    warps: WarpMap,
    undirected: bool = True,
) -> Dict[int, List[int]]:
    """Build adjacency lists from warp graph."""
    adjacency: Dict[int, Set[int]] = {s: set() for s in warps.keys()}
    for s, targets in warps.items():
        for t in targets:
            adjacency.setdefault(s, set()).add(t)
            if undirected:
                adjacency.setdefault(t, set()).add(s)
    return {s: sorted(neighbors) for s, neighbors in adjacency.items()}


def bfs_distances(adjacency: Dict[int, List[int]], start: int) -> Dict[int, int]:
    distances: Dict[int, int] = {start: 0}
    queue: deque[int] = deque([start])
    while queue:
        current = queue.popleft()
        current_distance = distances[current]
        for neighbor in adjacency.get(current, []):
            if neighbor in distances:
                continue
            distances[neighbor] = current_distance + 1
            queue.append(neighbor)
    return distances


def choose_graph_center(
    adjacency: Dict[int, List[int]],
    nodes: List[int],
    required_reach: int,
) -> Tuple[int, Dict[int, int]]:
    best_node: Optional[int] = None
    best_key: Optional[Tuple[int, int, int]] = None
    best_distances: Dict[int, int] = {}

    for node in nodes:
        distances = bfs_distances(adjacency, node)
        reach = len(distances)
        if reach < required_reach:
            continue
        eccentricity = max(distances.values()) if distances else 0
        key = (eccentricity, -reach, node)
        if best_key is None or key < best_key:
            best_key = key
            best_node = node
            best_distances = distances

    if best_node is None:
        raise RuntimeError(f"No sector can reach {required_reach} nodes; cannot place fedspace.")

    return best_node, best_distances


def select_fedspace(
    center: int,
    distances: Dict[int, int],
    adjacency: Dict[int, List[int]],
    count: int,
) -> List[int]:
    """Grow a connected Fedspace subgraph from the graph center."""
    selected: List[int] = [center]
    selected_set: Set[int] = {center}
    heap: List[Tuple[int, int]] = []
    for neighbor in adjacency.get(center, []):
        d = distances.get(neighbor)
        if d is not None:
            heapq.heappush(heap, (d, neighbor))

    while len(selected) < count and heap:
        d, sid = heapq.heappop(heap)
        if sid in selected_set:
            continue
        selected.append(sid)
        selected_set.add(sid)
        for neighbor in adjacency.get(sid, []):
            if neighbor in selected_set:
                continue
            nd = distances.get(neighbor)
            if nd is not None:
                heapq.heappush(heap, (nd, neighbor))

    if len(selected) < count:
        raise RuntimeError(
            f"Only {len(selected)} sectors reachable from {center} via fedspace-only "
            f"expansion; expected {count}."
        )
    return selected


def compute_distance_map(
    adjacency: Dict[int, List[int]],
    nodes: List[int],
) -> Dict[int, Dict[int, int]]:
    node_set = set(nodes)
    distances: Dict[int, Dict[int, int]] = {}
    for node in nodes:
        full = bfs_distances(adjacency, node)
        distances[node] = {target: dist for target, dist in full.items() if target in node_set}
    return distances


def select_mega_ports(
    fedspace: List[int],
    port_class_by_sector: PortClassMap,
    adjacency: Dict[int, List[int]],
    center_distances: Dict[int, int],
    mega_count: int,
    excluded_sectors: Optional[Set[int]] = None,
) -> List[int]:
    excluded = excluded_sectors or set()
    fedspace_candidates = [s for s in fedspace if s not in excluded]
    if len(fedspace_candidates) < mega_count:
        raise RuntimeError(
            f"Only {len(fedspace_candidates)} eligible fedspace sectors for mega-ports; need {mega_count}."
        )

    portless = [s for s in fedspace_candidates if s not in port_class_by_sector]
    if len(portless) < mega_count:
        logger.warning(
            "Only {} portless fedspace sectors; selecting mega-ports from all fedspace sectors.",
            len(portless),
        )
        candidates = fedspace_candidates
    else:
        candidates = portless

    distance_map = compute_distance_map(adjacency, candidates)

    first_candidates: List[Tuple[int, int]] = []
    for candidate in candidates:
        dist = center_distances.get(candidate)
        if dist is None:
            continue
        first_candidates.append((dist, candidate))

    if not first_candidates:
        raise RuntimeError("No mega-port candidates are reachable from the center sector.")

    first_candidates.sort(key=lambda item: (-item[0], item[1]))
    selected = [first_candidates[0][1]]

    while len(selected) < mega_count:
        best_candidate: Optional[int] = None
        best_score = -1
        for candidate in candidates:
            if candidate in selected:
                continue
            distances_to_selected: List[int] = []
            for chosen in selected:
                dist = distance_map.get(candidate, {}).get(chosen)
                if dist is None:
                    dist = distance_map.get(chosen, {}).get(candidate)
                if dist is None:
                    distances_to_selected = []
                    break
                distances_to_selected.append(dist)
            if not distances_to_selected:
                continue
            score = min(distances_to_selected)
            if score > best_score or (
                score == best_score and (best_candidate is None or candidate < best_candidate)
            ):
                best_candidate = candidate
                best_score = score
        if best_candidate is None:
            raise RuntimeError(
                "Unable to select enough mega-port sectors with mutual reachability."
            )
        selected.append(best_candidate)

    return selected


def ensure_fedspace_connected(
    adjacency: Dict[int, List[int]],
    fedspace: Set[int],
    mega_ports: Set[int],
    center_sector: int,
) -> None:
    """Validate Fedspace-only reachability from the center."""
    reachable: Set[int] = {center_sector}
    queue: deque[int] = deque([center_sector])
    while queue:
        current = queue.popleft()
        for neighbor in adjacency.get(current, []):
            if neighbor in fedspace and neighbor not in reachable:
                reachable.add(neighbor)
                queue.append(neighbor)

    unreachable_fedspace = fedspace - reachable
    if unreachable_fedspace:
        raise RuntimeError(
            f"Fedspace subgraph is not internally connected: "
            f"{len(unreachable_fedspace)} sector(s) unreachable from center "
            f"{center_sector} via fedspace-only warps."
        )

    unreachable_mega = mega_ports - reachable
    if unreachable_mega:
        raise RuntimeError(
            f"Mega-port sectors {sorted(unreachable_mega)} are not reachable "
            f"from center {center_sector} via fedspace-only warps."
        )


def complement_code(code: str) -> str:
    return "".join("S" if ch == "B" else "B" for ch in code)


def complement_class(port_class: int) -> int:
    return CODE_TO_CLASS[complement_code(CLASS_DEFS[port_class])]


def build_port_object(
    port_class: int,
    capacities: Optional[Dict[str, int]] = None,
    is_mega: bool = False,
) -> dict:
    """Create a port inventory payload."""
    code = CLASS_DEFS[port_class]

    if is_mega:
        capacities = {
            commodity: PORT_MAX_CAP * MEGA_PORT_STOCK_MULTIPLIER for commodity in COMMODITY_CODES
        }
    elif capacities is None:
        capacities = {
            commodity: random.randint(PORT_MIN_CAP, PORT_MAX_CAP) for commodity in COMMODITY_CODES
        }

    stock = {commodity: 0 for commodity in COMMODITY_CODES}
    stock_max = {commodity: 0 for commodity in COMMODITY_CODES}
    demand = {commodity: 0 for commodity in COMMODITY_CODES}
    demand_max = {commodity: 0 for commodity in COMMODITY_CODES}

    buys, sells = [], []
    for idx, com in enumerate(COMMODITY_CODES):
        capacity = capacities[com]

        if code[idx] == "S":
            stock_max[com] = capacity
            stock[com] = capacity
            sells.append(COM_LONG[com])
        else:
            demand_max[com] = capacity
            demand[com] = capacity
            buys.append(COM_LONG[com])

    port_data = {
        "class": port_class,
        "code": code,
        "buys": buys,
        "sells": sells,
        "stock": stock,
        "stock_max": stock_max,
        "demand": demand,
        "demand_max": demand_max,
    }

    if is_mega:
        port_data["is_mega"] = True

    return port_data


def place_ports(
    sector_positions: PositionMap,
    warps: WarpMap,
) -> PortClassMap:
    """Place ports with mild graph-aware bias (crossroads favored)."""
    target_port_count = round(PORT_PERCENTAGE * len(sector_positions))

    port_probabilities = {}
    for s in sector_positions:
        base_prob = 1.0
        degree = len(warps[s])
        if degree >= 5:
            base_prob *= 1.5
        elif degree == 1:
            base_prob *= 0.7
        port_probabilities[s] = base_prob

    total_prob = sum(port_probabilities.values())
    for s in port_probabilities:
        port_probabilities[s] /= total_prob

    sectors = list(sector_positions.keys())
    weights = [port_probabilities[s] for s in sectors]

    try:
        selected = np.random.choice(
            sectors,
            size=min(target_port_count, len(sectors)),
            replace=False,
            p=weights,
        )
        port_sectors = set(int(s) for s in selected)
    except Exception:
        sorted_sectors = sorted(sectors, key=lambda s: port_probabilities[s], reverse=True)
        port_sectors = set(sorted_sectors[:target_port_count])

    port_class_by_sector = {s: random.randint(1, 8) for s in port_sectors}
    tune_complementary_pairs(port_class_by_sector, warps, sector_positions)

    return port_class_by_sector


def tune_complementary_pairs(
    port_class_by_sector: PortClassMap,
    warps: WarpMap,
    positions: PositionMap,
) -> None:
    """Nudge port classes so complementary pairs exist nearby."""
    if not ENSURE_COMPLEMENTARY_PAIRS or not port_class_by_sector:
        return

    def find_nearby_sectors(sector: int, radius: int) -> Set[int]:
        visited = {sector}
        queue = deque([(sector, 0)])
        result = set()

        while queue:
            current, dist = queue.popleft()
            if dist >= radius:
                continue

            neighbors = warps[current]
            for next_sector in neighbors:
                if next_sector not in visited:
                    visited.add(next_sector)
                    result.add(next_sector)
                    queue.append((next_sector, dist + 1))

        return result

    for _ in range(MAX_PAIR_TUNING_PASSES):
        lacking = []

        for s, cls in port_class_by_sector.items():
            comp = complement_class(cls)
            nearby = find_nearby_sectors(s, COMPLEMENTARY_PAIR_RADIUS)

            has_complement = any(
                n in port_class_by_sector and port_class_by_sector[n] == comp for n in nearby
            )

            if not has_complement:
                lacking.append(s)

        if len(lacking) / len(port_class_by_sector) <= (1 - COMPLEMENTARY_PAIR_COVERAGE):
            break

        random.shuffle(lacking)
        for s in lacking[: len(lacking) // 2]:
            nearby = find_nearby_sectors(s, COMPLEMENTARY_PAIR_RADIUS)
            candidates = [n for n in nearby if n in port_class_by_sector]

            if candidates:
                target = random.choice(candidates)
                desired = complement_class(port_class_by_sector[target])
                port_class_by_sector[s] = desired


def main():
    parser = argparse.ArgumentParser(
        description="Generate a spatially-aware universe with regional structure"
    )
    parser.add_argument("sector_count", type=int, help="Number of sectors to generate")
    parser.add_argument("seed", type=int, nargs="?", help="Random seed (optional)")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force regeneration even if universe data already exists",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(settings.GRADIENTBANG_WORLD_DATA_DIR),
        help="Directory to write universe.json (default: GRADIENTBANG_WORLD_DATA_DIR)",
    )

    args = parser.parse_args()

    if args.sector_count <= 0:
        logger.error("sector_count must be a positive integer.")
        sys.exit(1)
    if FEDSPACE_SECTOR_COUNT > args.sector_count:
        logger.error(
            "FEDSPACE_SECTOR_COUNT ({}) exceeds sector_count ({}).",
            FEDSPACE_SECTOR_COUNT,
            args.sector_count,
        )
        sys.exit(1)
    if MEGA_PORT_COUNT > FEDSPACE_SECTOR_COUNT:
        logger.error(
            "MEGA_PORT_COUNT ({}) exceeds FEDSPACE_SECTOR_COUNT ({}).",
            MEGA_PORT_COUNT,
            FEDSPACE_SECTOR_COUNT,
        )
        sys.exit(1)

    output_dir = args.output_dir
    universe_path = output_dir / "universe.json"

    if universe_path.exists():
        if not args.force:
            logger.info("Universe data already exists at {}.", output_dir)
            logger.info("Use --force to regenerate and overwrite existing data")
            sys.exit(0)
        else:
            logger.info("Regenerating universe data at {}.", output_dir)

    if args.seed is not None:
        seed = args.seed
    else:
        seed = random.randrange(0, 2**32 - 1)
    random.seed(seed)
    np.random.seed(seed)

    logger.info("Generating {} sectors (seed {}).", args.sector_count, seed)

    grid_size = int(math.sqrt(args.sector_count * 4))
    hex_positions = generate_hex_grid(grid_size, grid_size)
    hex_positions = list(dict.fromkeys(hex_positions))

    sector_positions = place_sectors_uniform(hex_positions, args.sector_count)
    logger.info("Placed {} sectors.", len(sector_positions))

    warps = generate_connections(sector_positions)

    adjacency = build_adjacency_from_warps(warps, undirected=True)
    nodes = sorted(adjacency.keys())
    center_sector, center_distances = choose_graph_center(adjacency, nodes, FEDSPACE_SECTOR_COUNT)
    fedspace = select_fedspace(center_sector, center_distances, adjacency, FEDSPACE_SECTOR_COUNT)
    fedspace_set = set(fedspace)

    sector_regions = {s: NEUTRAL_REGION_ID for s in sector_positions}
    for sector_id in fedspace:
        sector_regions[sector_id] = FEDSPACE_REGION_ID

    port_class_by_sector = place_ports(sector_positions, warps)
    if 0 in port_class_by_sector:
        del port_class_by_sector[0]

    mega_port_sectors = select_mega_ports(
        fedspace=fedspace,
        port_class_by_sector=port_class_by_sector,
        adjacency=adjacency,
        center_distances=center_distances,
        mega_count=MEGA_PORT_COUNT,
        excluded_sectors={0},
    )
    for sector_id in mega_port_sectors:
        port_class_by_sector[sector_id] = 7

    mega_port_sector = mega_port_sectors[0] if mega_port_sectors else None
    mega_port_set = set(mega_port_sectors)

    ensure_fedspace_connected(adjacency, fedspace_set, mega_port_set, center_sector)

    logger.info("Fedspace center sector: {} ({} sectors).", center_sector, len(fedspace))
    logger.info("Mega-port sectors: {}", mega_port_sectors)
    logger.info("Ports placed: {} (sector 0 excluded)", len(port_class_by_sector))

    total_arcs = sum(len(v) for v in warps.values())
    two_way_arcs = sum(1 for s in sector_positions for t in warps[s] if s in warps.get(t, set()))
    two_way_fraction = two_way_arcs / total_arcs if total_arcs else 0.0

    universe_meta = {
        "sector_count": args.sector_count,
        "id_base": 0,
        "directed": True,
        "seed": seed,
        "spatial": True,
        "regions": [
            {
                "id": i,
                "name": r["name"],
            }
            for i, r in enumerate(REGIONS)
        ],
        "actual_two_way_arc_fraction": round(two_way_fraction, 3),
        "base_port_density": BASE_PORT_DENSITY,
        "initial_port_build_rate": INITIAL_PORT_BUILD_RATE,
        "port_percentage_effective": round(PORT_PERCENTAGE, 3),
        "mega_port_sectors": mega_port_sectors,
        "mega_port_sector": mega_port_sector,
        "fedspace_sectors": sorted(fedspace),
        "fedspace_region_name": FEDSPACE_REGION_NAME,
        "pricing_bands": {
            "sell_min": SELL_MIN,
            "sell_max": SELL_MAX,
            "buy_min": BUY_MIN,
            "buy_max": BUY_MAX,
        },
        "port_inventory": {
            "min_cap": PORT_MIN_CAP,
            "max_cap": PORT_MAX_CAP,
            "starting_fill_sell": PORT_STARTING_FILL_SELL,
            "starting_fill_buy": PORT_STARTING_FILL_BUY,
            "regen_fraction_stock": REGEN_FRACTION_STOCK,
            "regen_fraction_demand": REGEN_FRACTION_DEMAND,
        },
        "commodities": COM_LONG,
    }

    sectors_payload = []
    for s in range(args.sector_count):
        if s not in sector_positions:
            continue

        warp_list = []
        for t in sorted(warps.get(s, set())):
            warp_list.append(
                {
                    "to": t,
                    "two_way": s in warps.get(t, set()),
                }
            )

        port = None
        if s in port_class_by_sector:
            port = build_port_object(
                port_class_by_sector[s],
                is_mega=(s in mega_port_set),
            )

        sectors_payload.append(
            {
                "id": s,
                "position": {
                    "x": int(sector_positions[s][0]),
                    "y": int(sector_positions[s][1]),
                },
                "region": sector_regions[s],
                "warps": warp_list,
                "port": port,
                "planets": [],
                "scene_config": generate_scene_variant(s),
            }
        )

    universe = {
        "meta": universe_meta,
        "sectors": sectors_payload,
    }

    validation_report = validate_universe_data(universe)
    validation_summary = format_validation_report(validation_report)
    if not validation_report.passed:
        for line in validation_summary.splitlines():
            logger.error("Validation: {}", line)
        raise SystemExit(1)

    for line in validation_summary.splitlines():
        logger.info("Validation: {}", line)

    output_dir.mkdir(parents=True, exist_ok=True)
    universe_path.write_text(json.dumps(universe, indent=2) + "\n")

    logger.info(
        "Generation complete: ports={} fedspace_center={} mega_ports={} output={}",
        len(port_class_by_sector),
        center_sector,
        mega_port_sectors,
        universe_path,
    )


if __name__ == "__main__":
    main()
