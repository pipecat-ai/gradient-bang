#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = [
#     "numpy",
#     "scipy",
#     "networkx",
#     "loguru",
# ]
# ///
"""
Generate a spatially-aware universe with uniform density and a fedspace core.

Core techniques and features:
- Hexagonal grid base with snapped integer coordinates for stable layouts
- Uniform random sector placement (no regional density weighting)
- Global Delaunay triangulation pruned by distance to reduce crossings
  - Probabilistic one-way / two-way edges based on proximity
- Global two-way backbone using an MST over a global Delaunay graph to ensure
  strong connectivity (no unreachable sectors)
- Accessibility pass that upgrades a subset of short one-way edges to two-way
  to reduce trap-like areas without over-connecting
- Degree capping that preserves backbone edges and favors shorter connections
- Federation Space (fedspace) picked by graph center + shortest-path distance
- Ports placed with graph-awareness (crossroads favored); 4 mega-ports placed
  in fedspace and sector 0 is never a port

Outputs:
  - world-data/universe.json

Usage:
  python universe_bang.py <sector_count> [seed]
"""
import sys, json, random, math, argparse
import numpy as np
from collections import deque
from scipy.spatial import Delaunay
import networkx as nx
from typing import Dict, List, Set, Tuple, Optional
from loguru import logger
from gradientbang.scripts.scene_gen import generate_scene_variant
from gradientbang.utils.config import get_world_data_path

# ===================== Tunables / Defaults =====================

# --- Regions configuration ---
FEDSPACE_SECTOR_COUNT = 75
FEDSPACE_REGION_NAME = "Federation Space"
NEUTRAL_REGION_NAME = "Neutral"
FEDSPACE_REGION_ID = 1
NEUTRAL_REGION_ID = 0

REGIONS = [
    {"name": NEUTRAL_REGION_NAME},
    {"name": FEDSPACE_REGION_NAME},
]

# --- Hex grid parameters ---

# --- Connection parameters ---
MAX_DELAUNAY_EDGE_LENGTH = 3.5  # In hex units

# --- Port density (from original) ---
BASE_PORT_DENSITY = 0.40
INITIAL_PORT_BUILD_RATE = 0.95
PORT_PERCENTAGE = BASE_PORT_DENSITY * INITIAL_PORT_BUILD_RATE

# --- Mega port configuration ---
MEGA_PORT_STOCK_MULTIPLIER = 10  # 10x normal capacity
MEGA_PORT_COUNT = 3  # Three mega-ports per universe

# --- Warps / topology ---
MIN_WARPS_PER_SECTOR = 1
MAX_WARPS_PER_SECTOR = 2
TWO_WAY_PROBABILITY_ADJACENT = 0.7  # For nearby sectors
TWO_WAY_PROBABILITY_DISTANT = 0.3  # For distant sectors
DEGREE_CAP = 6  # Maximum connections per sector

# --- Complementary pairs ---
ENSURE_COMPLEMENTARY_PAIRS = True
COMPLEMENTARY_PAIR_RADIUS = 2
COMPLEMENTARY_PAIR_COVERAGE = 0.70
MAX_PAIR_TUNING_PASSES = 2

# --- Port inventory model ---
SELL_MIN, SELL_MAX = 0.75, 1.10
BUY_MIN, BUY_MAX = 0.90, 1.30

# Variable capacity per commodity (uniform random distribution)
PORT_MIN_CAP = 1000      # Minimum capacity per commodity
PORT_MAX_CAP = 10000     # Maximum capacity per commodity

# Fresh port state: sellers at 100%, buyers at 0% stock
PORT_STARTING_FILL_SELL = 1.0   # Sellers start at 100% stock (best prices)
PORT_STARTING_FILL_BUY = 0.0    # Buyers start at 0% stock (max demand)

# Legacy constants (kept for reference and mega port baseline)
PORT_DEFAULT_CAP = 1000          # Legacy - only used as reference
PORT_STARTING_FILL = 0.70        # Legacy - no longer used for fresh ports
REGEN_FRACTION_STOCK = 0.25
REGEN_FRACTION_DEMAND = 0.25

# --- Commodities & classes ---
COM_LONG = {
    "QF": "quantum_foam",
    "RO": "retro_organics",
    "NS": "neuro_symbolics",
}

CLASS_DEFS = {
    1: "BBS",
    2: "BSB",
    3: "SBB",
    4: "SSB",
    5: "SBS",
    6: "BSS",
    7: "SSS",
    8: "BBB",
}
CODE_TO_CLASS = {code: c for c, code in CLASS_DEFS.items()}

# ===================== Hex Grid Functions =====================

def generate_hex_grid(width: int, height: int) -> List[Tuple[float, float]]:
    """Generate hexagonal grid positions with integer coordinates."""
    positions = []
    for row in range(height):
        for col in range(width):
            x = col * 1.5
            y = row * math.sqrt(3)
            if col % 2 == 1:
                y += math.sqrt(3) / 2
            # Round to integers for clean coordinates
            positions.append((round(x), round(y)))
    return positions

def euclidean_distance(p1: Tuple[float, float], p2: Tuple[float, float]) -> float:
    """Calculate Euclidean distance between two points."""
    return math.sqrt((p1[0] - p2[0])**2 + (p1[1] - p2[1])**2)

def hex_distance(p1: Tuple[float, float], p2: Tuple[float, float]) -> float:
    """Calculate distance in hex units."""
    return euclidean_distance(p1, p2)

# ===================== Sector Placement =====================

def place_sectors_uniform(
    hex_positions: List[Tuple[float, float]],
    sector_count: int,
) -> Dict[int, Tuple[float, float]]:
    """Place sectors uniformly across the hex grid, snapped to hex positions."""
    if sector_count > len(hex_positions):
        raise ValueError(
            f"sector_count ({sector_count}) exceeds available hex positions ({len(hex_positions)})."
        )

    selected_hexes = random.sample(hex_positions, sector_count)
    return {sector_id: selected_hexes[sector_id] for sector_id in range(sector_count)}

# ===================== Connection Generation =====================

def generate_connections(
    positions: Dict[int, Tuple[float, float]],
) -> Dict[int, Set[int]]:
    """Generate connections with spatial awareness and minimal crossings."""
    warps = {s: set() for s in positions.keys()}
    sectors = list(positions.keys())

    if len(sectors) < 3:
        for i in range(len(sectors) - 1):
            s1, s2 = sectors[i], sectors[i + 1]
            warps[s1].add(s2)
            warps[s2].add(s1)
        return warps

    # Global Delaunay triangulation
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
    positions: Dict[int, Tuple[float, float]]
) -> Set[Tuple[int, int]]:
    """Build a global two-way backbone using an MST over a sparse planar graph.
    We construct a Delaunay triangulation over all sectors to get a sparse,
    low-crossing candidate graph, then compute a Euclidean MST and return its edges
    as undirected pairs (min_id, max_id).
    """
    sectors = list(positions.keys())
    if len(sectors) <= 1:
        return set()
    
    # Build Delaunay over all points for sparsity and low crossings
    pts = np.array([positions[s] for s in sectors])
    tri = Delaunay(pts)
    
    # Map local triangle vertex indices to sector ids
    edges = set()
    for simplex in tri.simplices:
        for i in range(3):
            a_idx, b_idx = simplex[i], simplex[(i+1) % 3]
            a, b = sectors[a_idx], sectors[b_idx]
            if a > b:
                a, b = b, a
            edges.add((a, b))
    
    # Build weighted sparse graph
    G = nx.Graph()
    G.add_nodes_from(sectors)
    for a, b in edges:
        dist = euclidean_distance(positions[a], positions[b])
        G.add_edge(a, b, weight=dist)
    
    # Compute MST
    mst = nx.minimum_spanning_tree(G, algorithm="kruskal")
    backbone = set()
    for a, b in mst.edges():
        if a > b:
            a, b = b, a
        backbone.add((a, b))
    return backbone

def ensure_connectivity(
    warps: Dict[int, Set[int]],
    positions: Dict[int, Tuple[float, float]]
) -> None:
    """Ensure basic connectivity with minimal changes to preserve planarity."""
    sectors = list(positions.keys())
    
    # First, ensure minimum outgoing connections per sector
    for s in sectors:
        out_degree = len(warps[s])
        
        if out_degree < MIN_WARPS_PER_SECTOR:
            # Find nearest unconnected sectors
            candidates = [
                (hex_distance(positions[s], positions[other]), other)
                for other in sectors
                if other != s and other not in warps[s]
            ]
            candidates.sort()
            
            # Add connections to nearest sectors only
            for _, other in candidates[:MIN_WARPS_PER_SECTOR - out_degree]:
                warps[s].add(other)
    
    # Create undirected graph to check basic connectivity
    G_undirected = nx.Graph()
    G_undirected.add_nodes_from(sectors)
    
    # Add edges (treat as undirected for basic connectivity)
    for s in sectors:
        for target in warps.get(s, set()):
            G_undirected.add_edge(s, target)
    
    # Find weakly connected components
    components = list(nx.connected_components(G_undirected))
    
    if len(components) > 1:
        logger.info(f"Found {len(components)} disconnected components, connecting them...")
        
        # Sort by size - largest is main component
        components.sort(key=len, reverse=True)
        main_component = components[0]
        
        # Connect each smaller component to main with minimal connections
        for comp_idx, component in enumerate(components[1:], 1):
            # Find the absolute closest pair between components
            best_dist = float('inf')
            best_pair = None
            
            for s1 in main_component:
                for s2 in component:
                    dist = hex_distance(positions[s1], positions[s2])
                    if dist < best_dist:
                        best_dist = dist
                        best_pair = (s1, s2)
            
            if best_pair and best_dist <= MAX_DELAUNAY_EDGE_LENGTH * 1.5:
                # Only connect if reasonably close
                s1, s2 = best_pair
                # Add bidirectional connection to ensure basic connectivity
                warps[s1].add(s2)
                warps[s2].add(s1)
                logger.info(f"  Connected component {comp_idx} ({len(component)} sectors) at distance {best_dist:.1f}")
                main_component = main_component.union(component)
            else:
                logger.warning(f"  Component {comp_idx} too far to connect (distance: {best_dist:.1f})")
    
    # Now check for dead-end paths and upgrade some one-way connections to two-way
    # This is less aggressive than full strong connectivity
    logger.info("Checking for accessibility issues...")
    
    G_directed = nx.DiGraph()
    G_directed.add_nodes_from(sectors)
    for s in sectors:
        for target in warps.get(s, set()):
            G_directed.add_edge(s, target)
    
    # Find sectors that are hard to escape from
    problem_sectors = []
    for sector in sectors:
        # Can we reach at least 50% of the graph from this sector?
        reachable = nx.descendants(G_directed, sector)
        if len(reachable) < len(sectors) * 0.5:
            problem_sectors.append(sector)
    
    if problem_sectors:
        logger.info(f"  Found {len(problem_sectors)} sectors with limited reachability")
        
        # For problem sectors, upgrade some of their connections to two-way
        upgrades_made = 0
        for sector in problem_sectors[:100]:  # Limit to avoid over-correction
            # Find existing one-way connections that could be made two-way
            for target in list(warps.get(sector, set())):
                if sector not in warps.get(target, set()):
                    # This is one-way, make it two-way if it's short
                    dist = hex_distance(positions[sector], positions[target])
                    if dist <= MAX_DELAUNAY_EDGE_LENGTH:
                        warps[target].add(sector)
                        upgrades_made += 1
                        break  # Only upgrade one per problem sector
        
        if upgrades_made > 0:
            logger.info(f"  Upgraded {upgrades_made} connections to two-way")

def collect_two_way_pairs(warps: Dict[int, Set[int]]) -> Set[Tuple[int, int]]:
    """Collect all undirected pairs that currently have mutual links.
    Returns pairs as (min_id, max_id)."""
    pairs: Set[Tuple[int, int]] = set()
    for s, neighbors in warps.items():
        for t in neighbors:
            if s in warps.get(t, set()):
                a, b = (s, t) if s < t else (t, s)
                pairs.add((a, b))
    return pairs

def cap_degrees(
    warps: Dict[int, Set[int]],
    positions: Dict[int, Tuple[float, float]],
    protected_undirected_edges: Optional[Set[Tuple[int, int]]] = None
) -> None:
    """Cap maximum degree by removing longest connections while preserving protected edges.
    protected_undirected_edges is a set of (min_id, max_id) pairs that must be retained
    bidirectionally.
    """
    protected_by_node: Dict[int, Set[int]] = {}
    if protected_undirected_edges:
        for a, b in protected_undirected_edges:
            protected_by_node.setdefault(a, set()).add(b)
            protected_by_node.setdefault(b, set()).add(a)
    
    for s, targets in warps.items():
        if len(targets) <= DEGREE_CAP:
            continue
        
        protected_neighbors = protected_by_node.get(s, set())
        # Sort by distance so we prefer to keep closer edges
        sorted_targets = sorted(
            targets,
            key=lambda t: hex_distance(positions[s], positions[t])
        )
        # Always include protected neighbors
        kept: List[int] = []
        kept_set: Set[int] = set()
        for t in sorted_targets:
            if t in protected_neighbors:
                kept.append(t)
                kept_set.add(t)
        # Fill remaining slots up to cap, but never drop protected ones
        cap = max(DEGREE_CAP, len(kept))
        for t in sorted_targets:
            if len(kept) >= cap:
                break
            if t in kept_set:
                continue
            kept.append(t)
            kept_set.add(t)
        warps[s] = set(kept)

# ===================== Fedspace Selection =====================

def build_adjacency_from_warps(
    warps: Dict[int, Set[int]],
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
        raise RuntimeError(
            f"No sector can reach {required_reach} nodes; cannot place fedspace."
        )

    return best_node, best_distances


def select_fedspace(
    center: int,
    distances: Dict[int, int],
    count: int,
) -> List[int]:
    ordered = sorted(distances.items(), key=lambda item: (item[1], item[0]))
    fedspace = [sector_id for sector_id, _distance in ordered[:count]]
    if len(fedspace) < count:
        raise RuntimeError(
            f"Only {len(fedspace)} sectors reachable from {center}, expected {count}."
        )
    return fedspace


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
    port_class_by_sector: Dict[int, int],
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
            if score > best_score or (score == best_score and (best_candidate is None or candidate < best_candidate)):
                best_candidate = candidate
                best_score = score
        if best_candidate is None:
            raise RuntimeError("Unable to select enough mega-port sectors with mutual reachability.")
        selected.append(best_candidate)

    return selected

# ===================== Port Generation =====================

def complement_code(code: str) -> str:
    """Get complement trading code."""
    return "".join("S" if ch == "B" else "B" for ch in code)

def complement_class(port_class: int) -> int:
    """Get complement port class."""
    return CODE_TO_CLASS[complement_code(CLASS_DEFS[port_class])]

def build_port_object(
    port_class: int,
    capacities: Optional[Dict[str, int]] = None,
    is_mega: bool = False
) -> dict:
    """Create a port with inventory fields.

    Args:
        port_class: Port class (1-8) defining buy/sell pattern
        capacities: Dict with 'QF', 'RO', 'NS' keys for per-commodity max capacity
                   If None, uses random capacities between PORT_MIN_CAP and PORT_MAX_CAP
        is_mega: If True, uses fixed MEGA_PORT_CAP (ignores random capacities)
    """
    code = CLASS_DEFS[port_class]

    # Mega ports get fixed high capacity; regular ports get random
    if is_mega:
        # Fixed 100,000 capacity for mega port (predictable hub)
        capacities = {
            "QF": PORT_MAX_CAP * MEGA_PORT_STOCK_MULTIPLIER,
            "RO": PORT_MAX_CAP * MEGA_PORT_STOCK_MULTIPLIER,
            "NS": PORT_MAX_CAP * MEGA_PORT_STOCK_MULTIPLIER,
        }
    elif capacities is None:
        # Random capacity per commodity for regular ports
        capacities = {
            "QF": random.randint(PORT_MIN_CAP, PORT_MAX_CAP),
            "RO": random.randint(PORT_MIN_CAP, PORT_MAX_CAP),
            "NS": random.randint(PORT_MIN_CAP, PORT_MAX_CAP),
        }

    # Initialize inventories
    stock = {"QF": 0, "RO": 0, "NS": 0}
    stock_max = {"QF": 0, "RO": 0, "NS": 0}
    demand = {"QF": 0, "RO": 0, "NS": 0}
    demand_max = {"QF": 0, "RO": 0, "NS": 0}

    buys, sells = [], []
    for com, idx in (("QF", 0), ("RO", 1), ("NS", 2)):
        capacity = capacities[com]

        if code[idx] == "S":
            # SELL commodity: start at 100% stock
            stock_max[com] = capacity
            stock[com] = capacity  # 100% full
            sells.append(COM_LONG[com])
        else:  # 'B'
            # BUY commodity: start at 0% stock (100% demand)
            demand_max[com] = capacity
            demand[com] = capacity  # demand_max - demand = 0 stock
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
    sector_positions: Dict[int, Tuple[float, float]],
    warps: Dict[int, Set[int]],
) -> Dict[int, int]:
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
    port_class_by_sector: Dict[int, int],
    warps: Dict[int, Set[int]],
    positions: Dict[int, Tuple[float, float]]
) -> None:
    """Ensure ports have complementary pairs nearby."""
    if not ENSURE_COMPLEMENTARY_PAIRS or not port_class_by_sector:
        return
    
    def find_nearby_sectors(sector: int, radius: int) -> Set[int]:
        """BFS to find sectors within radius hops."""
        visited = {sector}
        queue = deque([(sector, 0)])
        result = set()
        
        while queue:
            current, dist = queue.popleft()
            if dist >= radius:
                continue
            
            # Check outgoing and incoming connections
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
                n in port_class_by_sector and port_class_by_sector[n] == comp
                for n in nearby
            )
            
            if not has_complement:
                lacking.append(s)
        
        if len(lacking) / len(port_class_by_sector) <= (1 - COMPLEMENTARY_PAIR_COVERAGE):
            break
        
        random.shuffle(lacking)
        for s in lacking[:len(lacking)//2]:  # Adjust half of lacking ports
            nearby = find_nearby_sectors(s, COMPLEMENTARY_PAIR_RADIUS)
            candidates = [n for n in nearby if n in port_class_by_sector]
            
            if candidates:
                target = random.choice(candidates)
                desired = complement_class(port_class_by_sector[target])
                port_class_by_sector[s] = desired

# ===================== Main Generation =====================

def main():
    parser = argparse.ArgumentParser(
        description="Generate a spatially-aware universe with regional structure"
    )
    parser.add_argument("sector_count", type=int, help="Number of sectors to generate")
    parser.add_argument("seed", type=int, nargs="?", help="Random seed (optional)")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force regeneration even if world data already exists"
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
    
    # Check if world data already exists
    output_dir = get_world_data_path(ensure_exists=False)
    universe_path = output_dir / "universe.json"

    if universe_path.exists():
        if not args.force:
            logger.info(f"World data already exists at {output_dir}")
            logger.info("Use --force to regenerate and overwrite existing data")
            sys.exit(0)
        else:
            logger.info(f"Forcing regeneration of world data at {output_dir}")
    
    # Set random seed
    if args.seed is not None:
        seed = args.seed
    else:
        seed = random.randrange(0, 2**32 - 1)
    random.seed(seed)
    np.random.seed(seed)
    
    logger.info(f"Generating spatial universe with {args.sector_count} sectors...")
    logger.info(f"Random seed: {seed}")
    
    # Generate hex grid (oversized)
    grid_size = int(math.sqrt(args.sector_count * 4))
    hex_positions = generate_hex_grid(grid_size, grid_size)
    hex_positions = list(dict.fromkeys(hex_positions))

    # Place sectors uniformly
    sector_positions = place_sectors_uniform(hex_positions, args.sector_count)
    logger.info(f"Placed {len(sector_positions)} sectors")

    # Generate connections
    warps = generate_connections(sector_positions)

    # Choose fedspace sectors by graph center
    adjacency = build_adjacency_from_warps(warps, undirected=True)
    nodes = sorted(adjacency.keys())
    center_sector, center_distances = choose_graph_center(
        adjacency, nodes, FEDSPACE_SECTOR_COUNT
    )
    fedspace = select_fedspace(center_sector, center_distances, FEDSPACE_SECTOR_COUNT)
    fedspace_set = set(fedspace)

    sector_regions = {s: NEUTRAL_REGION_ID for s in sector_positions}
    for sector_id in fedspace:
        sector_regions[sector_id] = FEDSPACE_REGION_ID

    # Place ports
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

    logger.info(
        "Fedspace center sector: {} ({} sectors).", center_sector, len(fedspace)
    )
    logger.info("Mega-port sectors: {}", mega_port_sectors)
    logger.info("Ports placed: {} (sector 0 excluded)", len(port_class_by_sector))
    
    # Calculate statistics
    total_arcs = sum(len(v) for v in warps.values())
    two_way_arcs = sum(
        1 for s in sector_positions
        for t in warps[s]
        if s in warps.get(t, set())
    )
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
            # Legacy fields for reference
            "legacy_default_cap": PORT_DEFAULT_CAP,
            "legacy_starting_fill": PORT_STARTING_FILL,
        },
        "commodities": COM_LONG,
    }

    sectors_payload = []
    for s in range(args.sector_count):
        if s not in sector_positions:
            continue

        warp_list = []
        for t in sorted(warps.get(s, set())):
            warp_list.append({
                "to": t,
                "two_way": s in warps.get(t, set()),
            })

        port = None
        if s in port_class_by_sector:
            port = build_port_object(
                port_class_by_sector[s],
                is_mega=(s in mega_port_set),
            )

        sectors_payload.append({
            "id": s,
            "position": {
                "x": int(sector_positions[s][0]),
                "y": int(sector_positions[s][1]),
            },
            "region": sector_regions[s],
            "warps": warp_list,
            "port": port,
            "planets": [],  # No planets for now
            "scene_config": generate_scene_variant(s),
        })

    universe = {
        "meta": universe_meta,
        "sectors": sectors_payload,
    }
    
    # Write files to world-data directory (create if doesn't exist)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    with open(universe_path, "w") as f:
        json.dump(universe, f, indent=2)
    
    logger.info(f"Generated universe with {args.sector_count} sectors")
    logger.info(f"Two-way arcs: {two_way_fraction:.1%}")
    logger.info(f"Regions: {', '.join(r['name'] for r in REGIONS)}")
    logger.info(f"Fedspace sectors: {len(fedspace)} (center sector {center_sector})")
    logger.info(f"Mega-port sectors: {mega_port_sectors}")
    logger.info("Sector 0 port removed: yes")
    logger.info(f"File created: {universe_path}")

if __name__ == "__main__":
    main()
