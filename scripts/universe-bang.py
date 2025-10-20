#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = [
#     "numpy",
#     "scipy", 
#     "networkx",
# ]
# ///
"""
Generate a spatially-aware, low-crossing universe with regional structure and
guaranteed navigability.

Core techniques and features:
- Hexagonal grid base with snapped integer coordinates for stable layouts
- Regions via Voronoi-like clustering; sector counts allocated by regional density
- Sparse sector placement within regions for visual separation
- Per-region Delaunay triangulation pruned by distance to reduce crossings
  - Probabilistic one-way / two-way edges based on proximity
- Cross-region border connections between nearby sectors along region boundaries
- Global two-way backbone using an MST over a global Delaunay graph to ensure
  strong connectivity (no unreachable regions)
- Accessibility pass that upgrades a subset of short one-way edges to two-way to
  reduce trap-like areas without over-connecting
- Degree capping that preserves backbone edges and favors shorter connections
- Hyperlanes added last as strictly additional cross-region links:
  - Long-distance, two-way; endpoints must already have a same-region neighbor
    (so a hyperlane is never the only way out of a sector)
  - Preference for safe-to-safe region links to avoid forcing players through
    dangerous territory from safe zones
- Ports placed with regional bias and graph-awareness (crossroads favored);
  mega port located in a safe high-degree sector; complementary trade pairs are
  tuned within a small hop radius

Outputs:
  - world-data/universe_structure.json
  - world-data/sector_contents.json

Usage:
  python generate_spatial_universe.py <sector_count> [seed]
"""
import sys, json, random, math
import numpy as np
from collections import deque
from scipy.spatial import Delaunay, Voronoi
import networkx as nx
from dataclasses import dataclass
from typing import Dict, List, Set, Tuple, Optional

# ===================== Tunables / Defaults =====================

# --- Regions configuration ---
REGIONS = [
    {"name": "Core Worlds", "density": 0.7, "port_bias": 1.3, "safe": True},
    {"name": "Trade Federation", "density": 0.6, "port_bias": 1.5, "safe": True},
    {"name": "Frontier", "density": 0.35, "port_bias": 0.9, "safe": False},
    {"name": "Pirate Space", "density": 0.4, "port_bias": 0.6, "safe": False},
    {"name": "Neutral Zone", "density": 0.25, "port_bias": 1.0, "safe": True},
]

# --- Hex grid parameters ---

# --- Connection parameters ---
MAX_DELAUNAY_EDGE_LENGTH = 3.5  # In hex units
BORDER_CONNECTION_DISTANCE = 2.0  # In hex units
HYPERLANE_MIN_DISTANCE = 10.0  # In hex units
HYPERLANE_RATIO = 0.01  # 1% of sectors get hyperlanes

# --- Port density (from original) ---
BASE_PORT_DENSITY = 0.40
INITIAL_PORT_BUILD_RATE = 0.95
PORT_PERCENTAGE = BASE_PORT_DENSITY * INITIAL_PORT_BUILD_RATE

# --- Mega port configuration ---
MEGA_PORT_STOCK_MULTIPLIER = 10  # 10x normal capacity
MEGA_PORT_COUNT = 1  # One mega port per universe
MEGA_PORT_DYNAMIC_PLACEMENT = False  # If False, mega port is always at sector 0

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
PORT_DEFAULT_CAP = 1000
PORT_STARTING_FILL = 0.70
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

# ===================== Region Assignment =====================

def assign_hexes_to_regions(
    hex_positions: List[Tuple[float, float]], 
    num_regions: int
) -> Dict[int, int]:
    """Assign each hex position to a region using Voronoi-like clustering."""
    # Select region centers spread out across the grid
    indices = list(range(len(hex_positions)))
    random.shuffle(indices)
    
    # Space out region centers
    region_centers = []
    used_indices = set()
    
    for _ in range(num_regions):
        best_idx = None
        best_min_dist = 0
        
        for idx in indices:
            if idx in used_indices:
                continue
            
            if not region_centers:
                best_idx = idx
                break
            
            # Find minimum distance to existing centers
            min_dist = min(euclidean_distance(hex_positions[idx], hex_positions[c]) 
                          for c in region_centers)
            if min_dist > best_min_dist:
                best_min_dist = min_dist
                best_idx = idx
        
        if best_idx is not None:
            region_centers.append(best_idx)
            used_indices.add(best_idx)
    
    # Assign each hex to nearest region center
    hex_to_region = {}
    for i, pos in enumerate(hex_positions):
        distances = [(euclidean_distance(pos, hex_positions[c]), r) 
                    for r, c in enumerate(region_centers)]
        distances.sort()
        hex_to_region[i] = distances[0][1]
    
    return hex_to_region

# ===================== Sector Placement =====================

def place_sectors_in_regions(
    hex_positions: List[Tuple[float, float]],
    hex_to_region: Dict[int, int],
    sector_count: int,
    regions_info: List[Dict]
) -> Tuple[Dict[int, Tuple[float, float]], Dict[int, int]]:
    """Place sectors sparsely within their regions, snapped to hex grid."""
    sector_positions = {}
    sector_regions = {}
    
    # Calculate sectors per region based on density
    total_density = sum(r["density"] for r in regions_info)
    sectors_per_region = []
    for i, region in enumerate(regions_info):
        count = int(sector_count * region["density"] / total_density)
        sectors_per_region.append(count)
    
    # Adjust for rounding errors
    while sum(sectors_per_region) < sector_count:
        sectors_per_region[random.randint(0, len(sectors_per_region)-1)] += 1
    while sum(sectors_per_region) > sector_count:
        idx = random.randint(0, len(sectors_per_region)-1)
        if sectors_per_region[idx] > 1:
            sectors_per_region[idx] -= 1
    
    # Place sectors
    sector_id = 0
    for region_id, region_sector_count in enumerate(sectors_per_region):
        # Get hexes for this region
        region_hexes = [i for i, r in hex_to_region.items() if r == region_id]
        
        if not region_hexes:
            continue
        
        # Sample positions for sectors (this creates the sparse placement)
        num_to_place = min(region_sector_count, len(region_hexes))
        selected_hexes = random.sample(region_hexes, num_to_place)
        
        for hex_idx in selected_hexes:
            # Snap exactly to hex position - no jitter!
            sector_positions[sector_id] = hex_positions[hex_idx]
            sector_regions[sector_id] = region_id
            sector_id += 1
    
    return sector_positions, sector_regions

# ===================== Connection Generation =====================

def generate_regional_connections(
    positions: Dict[int, Tuple[float, float]],
    regions: Dict[int, int],
    regions_info: List[Dict]
) -> Tuple[Dict[int, Set[int]], List[Tuple[int, int]]]:
    """Generate connections with spatial awareness and minimal crossings."""
    warps = {s: set() for s in positions.keys()}
    
    # 1. Build Delaunay within each region
    for region_id in range(len(regions_info)):
        region_sectors = [s for s, r in regions.items() if r == region_id]
        
        if len(region_sectors) < 3:
            # Too few sectors for triangulation, connect linearly
            for i in range(len(region_sectors) - 1):
                s1, s2 = region_sectors[i], region_sectors[i + 1]
                warps[s1].add(s2)
                warps[s2].add(s1)
            continue
        
        # Get positions for triangulation
        region_positions = np.array([positions[s] for s in region_sectors])
        tri = Delaunay(region_positions)
        
        # Extract edges from triangulation
        edges = set()
        for simplex in tri.simplices:
            for i in range(3):
                a_idx, b_idx = simplex[i], simplex[(i+1)%3]
                a, b = region_sectors[a_idx], region_sectors[b_idx]
                if a > b:
                    a, b = b, a
                edges.add((a, b))
        
        # Add edges based on distance
        for s1, s2 in edges:
            dist = hex_distance(positions[s1], positions[s2])
            
            # Skip very long edges
            if dist > MAX_DELAUNAY_EDGE_LENGTH:
                continue
            
            # Determine connection type
            if dist <= 1.5:  # Adjacent hexes
                if random.random() < TWO_WAY_PROBABILITY_ADJACENT:
                    warps[s1].add(s2)
                    warps[s2].add(s1)
                else:
                    if random.random() < 0.5:
                        warps[s1].add(s2)
                    else:
                        warps[s2].add(s1)
            else:  # More distant
                if random.random() < TWO_WAY_PROBABILITY_DISTANT:
                    warps[s1].add(s2)
                    warps[s2].add(s1)
                else:
                    if random.random() < 0.5:
                        warps[s1].add(s2)
                    else:
                        warps[s2].add(s1)
    
    # 2. Add border connections
    add_border_connections(warps, positions, regions)
    
    # 3. Add global two-way backbone to guarantee strong connectivity
    backbone_edges = build_backbone_edges(positions)
    for s1, s2 in backbone_edges:
        warps[s1].add(s2)
        warps[s2].add(s1)
    
    # 4. Ensure accessibility (dead-ends and limited reachability clean-up)
    ensure_connectivity(warps, positions)
    
    # 5. Cap degrees while preserving backbone edges and any mutual two-way pairs
    protected_pairs = set(backbone_edges)
    protected_pairs.update(collect_two_way_pairs(warps))
    cap_degrees(warps, positions, protected_undirected_edges=protected_pairs)
    
    # 6. Add hyperlanes (special long-distance warps) AFTER connectivity/capping
    hyperlanes = add_hyperlanes(warps, positions, regions)
    
    return warps, hyperlanes

def add_border_connections(
    warps: Dict[int, Set[int]],
    positions: Dict[int, Tuple[float, float]],
    regions: Dict[int, int]
) -> None:
    """Add connections between regions at borders."""
    border_pairs = []
    sectors = list(positions.keys())
    
    for i, s1 in enumerate(sectors):
        for s2 in sectors[i+1:]:
            if regions[s1] != regions[s2]:
                dist = hex_distance(positions[s1], positions[s2])
                if dist <= BORDER_CONNECTION_DISTANCE:
                    border_pairs.append((dist, s1, s2))
    
    # Sort by distance and add connections
    border_pairs.sort()
    num_borders = min(len(border_pairs), len(sectors) // 20)
    
    for _, s1, s2 in border_pairs[:num_borders]:
        # Border crossings
        if random.random() < 0.3:
            warps[s1].add(s2)
            warps[s2].add(s1)
        else:
            if random.random() < 0.7:
                warps[s1].add(s2)
            else:
                warps[s2].add(s1)

def add_hyperlanes(
    warps: Dict[int, Set[int]],
    positions: Dict[int, Tuple[float, float]],
    regions: Dict[int, int]
) -> List[Tuple[int, int]]:
    """Add long-distance hyperlanes after the graph is already connected.
    Rules:
      - Only connect sectors in different regions and far apart (min distance)
      - Never be the only way out of a sector: endpoints must already have a
        same-region neighbor before adding the hyperlane
      - Prefer safe-to-safe region links when possible
    """
    hyperlanes: List[Tuple[int, int]] = []
    sectors = list(positions.keys())
    num_hyperlanes = max(1, int(len(sectors) * HYPERLANE_RATIO))
    
    # Build helper for region safety
    def is_safe(sector_id: int) -> bool:
        region_id = regions[sector_id]
        return REGIONS[region_id].get("safe", False)
    
    def has_same_region_neighbor(sector_id: int) -> bool:
        region_id = regions[sector_id]
        for neighbor in warps.get(sector_id, set()):
            if regions[neighbor] == region_id:
                return True
        return False
    
    attempts = 0
    # Allow higher attempt budget because of constraints
    max_attempts = num_hyperlanes * 50
    while len(hyperlanes) < num_hyperlanes and attempts < max_attempts:
        attempts += 1
        s1 = random.choice(sectors)
        # Endpoint must already have an intra-region neighbor so the hyperlane is not the only exit
        if not has_same_region_neighbor(s1):
            continue
        
        # Base cross-region, far-enough, not already connected, and also has intra-region neighbor
        base_candidates = [
            s for s in sectors
            if regions[s] != regions[s1]
            and hex_distance(positions[s1], positions[s]) >= HYPERLANE_MIN_DISTANCE
            and s not in warps[s1]
            and has_same_region_neighbor(s)
        ]
        if not base_candidates:
            continue
        
        # Prefer safe-to-safe when possible
        if is_safe(s1):
            preferred = [s for s in base_candidates if is_safe(s)]
            if preferred:
                s2 = random.choice(preferred)
            else:
                s2 = random.choice(base_candidates)
        else:
            s2 = random.choice(base_candidates)
        
        # Add two-way hyperlane
        warps[s1].add(s2)
        warps[s2].add(s1)
        a, b = (s1, s2) if s1 < s2 else (s2, s1)
        hyperlanes.append((a, b))
    
    return hyperlanes

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
        print(f"Found {len(components)} disconnected components, connecting them...")
        
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
                print(f"  Connected component {comp_idx} ({len(component)} sectors) at distance {best_dist:.1f}")
                main_component = main_component.union(component)
            else:
                print(f"  Warning: Component {comp_idx} too far to connect (distance: {best_dist:.1f})")
    
    # Now check for dead-end paths and upgrade some one-way connections to two-way
    # This is less aggressive than full strong connectivity
    print("Checking for accessibility issues...")
    
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
        print(f"  Found {len(problem_sectors)} sectors with limited reachability")
        
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
            print(f"  Upgraded {upgrades_made} connections to two-way")

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

# ===================== Port Generation =====================

def complement_code(code: str) -> str:
    """Get complement trading code."""
    return "".join("S" if ch == "B" else "B" for ch in code)

def complement_class(port_class: int) -> int:
    """Get complement port class."""
    return CODE_TO_CLASS[complement_code(CLASS_DEFS[port_class])]

def build_port_object(
    port_class: int,
    default_cap: int = PORT_DEFAULT_CAP,
    start_fill: float = PORT_STARTING_FILL,
    is_mega: bool = False
) -> dict:
    """Create a port with inventory fields."""
    code = CLASS_DEFS[port_class]
    
    # Adjust capacity for mega port
    capacity = default_cap * (MEGA_PORT_STOCK_MULTIPLIER if is_mega else 1)
    
    # Initialize inventories
    stock = {"QF": 0, "RO": 0, "NS": 0}
    stock_max = {"QF": 0, "RO": 0, "NS": 0}
    demand = {"QF": 0, "RO": 0, "NS": 0}
    demand_max = {"QF": 0, "RO": 0, "NS": 0}
    
    buys, sells = [], []
    for com, idx in (("QF", 0), ("RO", 1), ("NS", 2)):
        if code[idx] == "S":
            stock_max[com] = capacity
            stock[com] = int(round(capacity * start_fill))
            sells.append(COM_LONG[com])
        else:  # 'B'
            demand_max[com] = capacity
            demand[com] = int(round(capacity * start_fill))
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
    sector_regions: Dict[int, int],
    regions_info: List[Dict],
    warps: Dict[int, Set[int]]
) -> Tuple[Dict[int, int], int]:
    """Place ports with regional bias and ensure mega port in safe zone."""
    target_port_count = round(PORT_PERCENTAGE * len(sector_positions))
    
    # Calculate port probability for each sector
    port_probabilities = {}
    for s, region_id in sector_regions.items():
        base_prob = regions_info[region_id]["port_bias"]
        
        # Boost probability for crossroads (high degree)
        degree = len(warps[s])
        if degree >= 5:
            base_prob *= 1.5
        elif degree == 1:
            base_prob *= 0.7
        
        port_probabilities[s] = base_prob
    
    # Normalize probabilities
    total_prob = sum(port_probabilities.values())
    for s in port_probabilities:
        port_probabilities[s] /= total_prob
    
    # Select sectors for ports
    sectors = list(sector_positions.keys())
    weights = [port_probabilities[s] for s in sectors]
    
    # Use numpy for weighted selection if available, else fall back
    try:
        selected = np.random.choice(
            sectors, 
            size=min(target_port_count, len(sectors)),
            replace=False,
            p=weights
        )
        # Convert numpy int64 to Python int
        port_sectors = set(int(s) for s in selected)
    except:
        # Fallback: sort by probability and take top
        sorted_sectors = sorted(sectors, key=lambda s: port_probabilities[s], reverse=True)
        port_sectors = set(sorted_sectors[:target_port_count])
    
    # Assign initial random classes
    port_class_by_sector = {s: random.randint(1, 8) for s in port_sectors}

    # Choose mega port location based on configuration
    if MEGA_PORT_DYNAMIC_PLACEMENT:
        # Choose mega port location (in safe zone with high degree)
        safe_regions = [i for i, r in enumerate(regions_info) if r.get("safe", False)]
        safe_ports = [s for s in port_sectors if sector_regions[s] in safe_regions]

        if safe_ports:
            # Prefer high-degree safe port
            mega_port_sector = int(max(safe_ports, key=lambda s: len(warps[s])))
        else:
            # Fallback: any high-degree port
            mega_port_sector = int(max(port_sectors, key=lambda s: len(warps[s])))
    else:
        # Fixed placement at sector 0; ensure sector 0 is a port
        mega_port_sector = 0
        if mega_port_sector not in port_sectors:
            port_sectors.add(mega_port_sector)
            port_class_by_sector[mega_port_sector] = 7  # Ensure presence and class

    # Make it class 7 (SSS - sells all)
    port_class_by_sector[mega_port_sector] = 7
    
    # Tune complementary pairs
    tune_complementary_pairs(port_class_by_sector, warps, sector_positions)
    
    return port_class_by_sector, mega_port_sector

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
    if len(sys.argv) < 2:
        print("Usage: python generate_spatial_universe.py <sector_count> [seed]")
        sys.exit(1)
    
    sector_count = int(sys.argv[1])
    if sector_count <= 0:
        print("sector_count must be a positive integer.")
        sys.exit(1)
    
    # Set random seed
    if len(sys.argv) >= 3:
        seed = int(sys.argv[2])
    else:
        seed = random.randrange(0, 2**32 - 1)
    random.seed(seed)
    np.random.seed(seed)
    
    print(f"Generating spatial universe with {sector_count} sectors...")
    print(f"Random seed: {seed}")
    
    # Generate hex grid (oversized)
    grid_size = int(math.sqrt(sector_count * 4))
    hex_positions = generate_hex_grid(grid_size, grid_size)
    
    # Assign hexes to regions
    hex_to_region = assign_hexes_to_regions(hex_positions, len(REGIONS))
    
    # Place sectors
    sector_positions, sector_regions = place_sectors_in_regions(
        hex_positions, hex_to_region, sector_count, REGIONS
    )
    
    print(f"Placed {len(sector_positions)} sectors across {len(REGIONS)} regions")
    
    # Generate connections
    warps, hyperlanes = generate_regional_connections(
        sector_positions, sector_regions, REGIONS
    )
    
    # Convert hyperlanes to set for easy lookup
    hyperlane_set = set()
    for s1, s2 in hyperlanes:
        hyperlane_set.add((min(s1, s2), max(s1, s2)))
    
    # Place ports
    port_class_by_sector, mega_port_sector = place_ports(
        sector_positions, sector_regions, REGIONS, warps
    )
    
    print(f"Placed {len(port_class_by_sector)} ports including mega port at sector {mega_port_sector}")
    
    # Calculate statistics
    total_arcs = sum(len(v) for v in warps.values())
    two_way_arcs = sum(
        1 for s in sector_positions
        for t in warps[s]
        if s in warps.get(t, set())
    )
    two_way_fraction = two_way_arcs / total_arcs if total_arcs else 0.0
    
    # Build universe_structure.json
    universe_structure = {
        "meta": {
            "sector_count": sector_count,
            "id_base": 0,
            "directed": True,
            "seed": seed,
            "spatial": True,
            "regions": [
                {
                    "id": i,
                    "name": r["name"],
                    "safe": r.get("safe", False)
                }
                for i, r in enumerate(REGIONS)
            ],
            "actual_two_way_arc_fraction": round(two_way_fraction, 3),
        },
        "sectors": []
    }
    
    for s in range(sector_count):
        if s in sector_positions:
            warp_list = []
            for t in sorted(warps.get(s, set())):
                warp_data = {
                    "to": t,
                    "two_way": s in warps.get(t, set())
                }
                
                # Flag cross-region warps
                target_sector = next((sec for sec in universe_structure["sectors"] 
                                     if sec["id"] == t), None)
                if target_sector and "region" in target_sector:
                    if target_sector["region"] != sector_regions[s]:
                        warp_data["crosses_region"] = True
                        warp_data["to_region"] = target_sector["region"]
                
                # Flag if this is a hyperlane (long-distance warp)
                pair = (min(s, t), max(s, t))
                if pair in hyperlane_set:
                    warp_data["is_hyperlane"] = True
                    warp_data["distance"] = round(hex_distance(sector_positions[s], sector_positions[t]), 1)
                
                warp_list.append(warp_data)
            
            universe_structure["sectors"].append({
                "id": s,
                "position": {
                    "x": int(sector_positions[s][0]),
                    "y": int(sector_positions[s][1])
                },
                "region": sector_regions[s],
                "warps": warp_list
            })
    
    # Build sector_contents.json
    contents_meta = {
        "sector_count": sector_count,
        "seed": seed,
        "base_port_density": BASE_PORT_DENSITY,
        "initial_port_build_rate": INITIAL_PORT_BUILD_RATE,
        "port_percentage_effective": round(PORT_PERCENTAGE, 3),
        "mega_port_sector": mega_port_sector,
        "pricing_bands": {
            "sell_min": SELL_MIN,
            "sell_max": SELL_MAX,
            "buy_min": BUY_MIN,
            "buy_max": BUY_MAX,
        },
        "port_inventory": {
            "default_cap": PORT_DEFAULT_CAP,
            "starting_fill": PORT_STARTING_FILL,
            "regen_fraction_stock": REGEN_FRACTION_STOCK,
            "regen_fraction_demand": REGEN_FRACTION_DEMAND,
        },
        "commodities": COM_LONG,
    }
    
    sector_contents_list = []
    
    for s in range(sector_count):
        if s not in sector_positions:
            continue
        
        port = None
        if s in port_class_by_sector:
            port = build_port_object(
                port_class_by_sector[s],
                PORT_DEFAULT_CAP,
                PORT_STARTING_FILL,
                is_mega=(s == mega_port_sector)
            )
        
        sector_contents_list.append({
            "id": s,
            "port": port,
            "planets": []  # No planets for now
        })
    
    universe_contents = {
        "meta": contents_meta,
        "sectors": sector_contents_list
    }
    
    # Write files to world-data directory (create if doesn't exist)
    import os
    output_dir = "world-data"
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)
    
    universe_structure_path = os.path.join(output_dir, "universe_structure.json")
    sector_contents_path = os.path.join(output_dir, "sector_contents.json")
    
    with open(universe_structure_path, "w") as f:
        json.dump(universe_structure, f, indent=2)
    
    with open(sector_contents_path, "w") as f:
        json.dump(universe_contents, f, indent=2)
    
    print(f"Generated universe with {sector_count} sectors")
    print(f"Two-way arcs: {two_way_fraction:.1%}")
    print(f"Regions: {', '.join(r['name'] for r in REGIONS)}")
    print(f"Mega port in {REGIONS[sector_regions[mega_port_sector]]['name']} at sector {mega_port_sector}")
    print(f"Files created: {universe_structure_path}, {sector_contents_path}")

if __name__ == "__main__":
    main()