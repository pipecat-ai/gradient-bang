#!/usr/bin/env python3
"""
Generate a universe with self-describing ports that include inventory (stock/demand).
- 0-indexed sector IDs
- Connected directed graph with mix of one-way/two-way warps
- Ports include class, code, stock/stock_max, demand/demand_max
- Optional complementary-pair tuning so many ports have a nearby complement
- Planets: OFF by default for MVP (set GENERATE_PLANETS=True to re-enable)

Outputs:
  - universe_structure.json
  - sector_contents.json

Usage:
  python generate_universe.py <sector_count> [seed]
"""

import sys, json, random, heapq
from collections import deque

# ===================== Tunables / Defaults =====================

# --- Port density (stock-ish TWGS feel) ---
BASE_PORT_DENSITY = 0.40  # ~ "maximum possible starports"
INITIAL_PORT_BUILD_RATE = 0.95  # ~ "initial starports to build"
PORT_PERCENTAGE = BASE_PORT_DENSITY * INITIAL_PORT_BUILD_RATE  # ~0.38 effective

# --- Planets (MVP OFF) ---
GENERATE_PLANETS = False
PLANET_PERCENTAGE = 0.00  # raise if you re-enable planets

# --- Warps / topology ---
MIN_WARPS_PER_SECTOR = 1
MAX_WARPS_PER_SECTOR = 2
TWO_WAY_PROBABILITY = 0.05  # extras: mostly one-way; two-way is special
DEGREE_CAP_UND = 4  # hard cap for undirected degree (applied to extras; tree respects this too)
MAX_TREE_DEG = 4    # maximum undirected degree in the spanning backbone (root included)
RARE_SPUR_TARGET = 100  # aim for ~100 two-hop cul-de-sacs in a 5k universe
RARE_SPUR_MIN_SEP = 10  # hop separation between spur anchors (fallback to 8, then 6)

# --- Encourage complementary port pairs nearby ---
ENSURE_COMPLEMENTARY_PAIRS = True
COMPLEMENTARY_PAIR_RADIUS = 2  # hops (undirected)
COMPLEMENTARY_PAIR_COVERAGE = 0.70  # try to reach >= 70%
MAX_PAIR_TUNING_PASSES = 2

# --- Port inventory model (used by your runtime pricing) ---
# Price bands (server uses these to compute dynamic prices from stock/demand)
SELL_MIN, SELL_MAX = 0.75, 1.10  # port sells to player
BUY_MIN, BUY_MAX = 0.90, 1.30  # port buys from player
# Inventory capacities & starting fill
PORT_DEFAULT_CAP = 1000  # per-commodity capacity baseline
PORT_STARTING_FILL = 0.70  # start at 70% stock/demand available
# Optional regen hints (the generator only records these in meta)
REGEN_FRACTION_STOCK = 0.25
REGEN_FRACTION_DEMAND = 0.25

# --- Cosmetic / meta hints ---
COURSE_LENGTH_HINT = 45  # classic feel

# --- Commodities & classes ---
COM_LONG = {
    "QF": "quantum_foam",
    "RO": "retro_organics",
    "NS": "neuro_symbolics",
}  # labels for readability

# Port class (1..8) -> code ("B"/"S") for QF, RO, NS
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

# Planet classes (if you re-enable)
PLANET_CLASS_INFO = {
    "M": {"name": "Earthlike"},
    "K": {"name": "Desert"},
    "O": {"name": "Oceanic"},
    "L": {"name": "Mountainous"},
    "C": {"name": "Glacial"},
    "H": {"name": "Volcanic"},
    "U": {"name": "Gaseous"},
}

# ===================== Helpers =====================


def usage_and_exit():
    print("Usage: python generate_universe.py <sector_count> [seed]")
    sys.exit(1)


def complement_code(code: str) -> str:
    return "".join("S" if ch == "B" else "B" for ch in code)


def complement_class(port_class: int) -> int:
    return CODE_TO_CLASS[complement_code(CLASS_DEFS[port_class])]


def bfs_within_radius(start: int, neighbors: list[list[int]], radius: int) -> set:
    """Undirected BFS up to 'radius' hops; returns visited nodes excluding start."""
    from collections import deque

    visited = {start}
    q = deque([(start, 0)])
    result = set()
    while q:
        node, dist = q.popleft()
        if dist == radius:
            continue
        for nb in neighbors[node]:
            if nb not in visited:
                visited.add(nb)
                result.add(nb)
                q.append((nb, dist + 1))
    result.discard(start)
    return result


def build_planet_object(pid: int) -> dict:
    class_code = random.choice(list(PLANET_CLASS_INFO.keys()))
    return {
        "id": f"PL-{pid:05d}",
        "class_code": class_code,
        "class_name": PLANET_CLASS_INFO[class_code]["name"],
    }


def build_port_object(
    port_class: int,
    default_cap: int = PORT_DEFAULT_CAP,
    start_fill: float = PORT_STARTING_FILL,
) -> dict:
    """
    Create a self-describing port with inventory fields for your runtime pricing model.
    - For letters 'S' (sell): fill stock/stock_max.
    - For letters 'B' (buy):  fill demand/demand_max.
    """
    code = CLASS_DEFS[port_class]

    # Initialize dictionaries for all commodities
    stock = {"QF": 0, "RO": 0, "NS": 0}
    stock_max = {"QF": 0, "RO": 0, "NS": 0}
    demand = {"QF": 0, "RO": 0, "NS": 0}
    demand_max = {"QF": 0, "RO": 0, "NS": 0}

    buys, sells = [], []
    for com, idx in (("QF", 0), ("RO", 1), ("NS", 2)):
        if code[idx] == "S":
            stock_max[com] = default_cap
            stock[com] = int(round(default_cap * start_fill))
            sells.append(COM_LONG[com])
        else:  # 'B'
            demand_max[com] = default_cap
            demand[com] = int(round(default_cap * start_fill))
            buys.append(COM_LONG[com])

    return {
        "class": port_class,
        "code": code,
        "buys": buys,  # human-readable commodity names
        "sells": sells,  # human-readable commodity names
        "stock": stock,
        "stock_max": stock_max,
        "demand": demand,
        "demand_max": demand_max,
    }


# ===================== Main =====================


def main():
    if len(sys.argv) < 2:
        usage_and_exit()

    sector_count = int(sys.argv[1])
    if sector_count <= 0:
        print("sector_count must be a positive integer.")
        sys.exit(1)

    # Optional RNG seed for reproducibility
    if len(sys.argv) >= 3:
        seed = int(sys.argv[2])
    else:
        seed = random.randrange(0, 2**32 - 1)
    random.seed(seed)

    # --- Build a connected undirected tree with bounded degree (capacity-limited BFS) ---
    # Then convert to a two-way directed backbone. This prevents high-degree hubs in the tree.
    warps_outgoing = {s: set() for s in range(sector_count)}

    n = sector_count
    tree_neighbors = [set() for _ in range(n)]
    if sector_count == 1:
        parent = {0: None}
    else:
        # Remaining capacity for each node (how many total neighbors it may have)
        cap = [MAX_TREE_DEG] * n
        # Choose a random root to avoid density bias near 0
        root = random.randrange(n)
        parent = {root: None}
        # Frontier of nodes that can accept new children (start with root)
        frontier = [root]
        # Create a random order of the remaining nodes
        remaining = [i for i in range(n) if i != root]
        random.shuffle(remaining)
        for s in remaining:
            if not frontier:
                frontier = [random.choice(list(range(n)))]
            # Pick a parent from frontier with available capacity
            p = random.choice(frontier)
            if cap[p] <= 0:
                # find someone else with capacity
                frontier = [f for f in frontier if cap[f] > 0] or [p]
                p = random.choice(frontier)
            # Connect p <-> s
            tree_neighbors[p].add(s)
            tree_neighbors[s].add(p)
            warps_outgoing[p].add(s)
            warps_outgoing[s].add(p)
            parent[s] = p
            # Update capacities: one slot consumed for p and for s
            cap[p] -= 1
            cap[s] = MAX_TREE_DEG - 1  # one used by parent link
            # Maintain frontier
            if cap[p] <= 0 and p in frontier:
                frontier.remove(p)
            if cap[s] > 0:
                frontier.append(s)

    # --- Identify rare two-hop cul-de-sacs on the tree and seal their interior nodes ---
    # tree_neighbors already computed from the Prüfer tree above

    # Candidate triples (a,u,v): v is leaf, u has degree 2, a is parent of u
    candidates = []
    for v in range(sector_count):
        if len(tree_neighbors[v]) != 1:
            continue
        u = parent.get(v)
        if u is None:
            # v might be 0 (root)
            continue
        if len(tree_neighbors[u]) != 2:
            continue
        a = parent.get(u)
        if a is None:
            continue
        candidates.append((a, u, v))

    # Keep at most one triple per anchor a
    by_anchor = {}
    for a, u, v in candidates:
        if a not in by_anchor:
            by_anchor[a] = (a, u, v)

    anchors = list(by_anchor.keys())

    # Helper: BFS within radius on the tree
    def bfs_tree_radius(start: int, radius: int) -> set[int]:
        visited = {start}
        q = deque([(start, 0)])
        result = set()
        while q:
            n, d = q.popleft()
            if d == radius:
                continue
            for nb in tree_neighbors[n]:
                if nb not in visited:
                    visited.add(nb)
                    result.add(nb)
                    q.append((nb, d + 1))
        return result

    # Greedy, spaced selection of anchors
    selected = []
    def select_with_minsep(min_sep: int):
        selected.clear()
        remaining = set(anchors)
        # Prefer anchors far from node 0 (coarse spread)
        # Compute tree rings from 0 for simple priority
        dist0 = {0: 0}
        q = deque([0])
        while q:
            x = q.popleft()
            for y in tree_neighbors[x]:
                if y not in dist0:
                    dist0[y] = dist0[x] + 1
                    q.append(y)
        ordered = sorted(list(remaining), key=lambda a: dist0.get(a, 0), reverse=True)
        blocked = set()
        for a in ordered:
            if a in blocked or a not in remaining:
                continue
            selected.append(a)
            if len(selected) >= RARE_SPUR_TARGET:
                break
            # Block anchors within min_sep hops
            for n in bfs_tree_radius(a, min_sep):
                if n in remaining:
                    blocked.add(n)
        return len(selected)

    ok = select_with_minsep(RARE_SPUR_MIN_SEP)
    if ok < RARE_SPUR_TARGET:
        ok = select_with_minsep(max(8, RARE_SPUR_MIN_SEP - 2))
    if ok < RARE_SPUR_TARGET:
        select_with_minsep(max(6, RARE_SPUR_MIN_SEP - 4))

    SEALED = set()
    selected_triples = []
    for a in selected[:RARE_SPUR_TARGET]:
        a, u, v = by_anchor[a]
        SEALED.add(u)
        SEALED.add(v)
        selected_triples.append((a, u, v))

    # Compute coarse rings (from node 0 on the tree) for cross-ring discipline
    ring = {root: 0}
    q = deque([root])
    while q:
        x = q.popleft()
        for y in tree_neighbors[x]:
            if y not in ring:
                ring[y] = ring[x] + 1
                q.append(y)

    # Precompute depth and parent for LCA approximation on the backbone tree
    depth = ring.copy()
    up = parent  # immediate parent mapping from earlier tree build

    def lca_depth(a: int, b: int) -> int:
        # Bring to same depth
        da, db = depth.get(a, 0), depth.get(b, 0)
        while da > db:
            a = up.get(a)
            da -= 1
            if a is None:
                break
        while db > da:
            b = up.get(b)
            db -= 1
            if b is None:
                break
        # Climb together
        while a is not None and b is not None and a != b:
            a = up.get(a)
            b = up.get(b)
        return depth.get(a, 0) if a is not None else 0

    # Extra warps: mix of one-way/two-way with guardrails
    # Maintain dynamic undirected degree for the soft cap
    und_adj = tree_neighbors  # dynamic undirected adjacency
    und_deg = [len(neis) for neis in und_adj]

    # Precompute desired extras per node to avoid order bias
    desired_map = {}
    for s in range(sector_count):
        desired_map[s] = random.randint(MIN_WARPS_PER_SECTOR, MAX_WARPS_PER_SECTOR)

    # Round-robin passes to distribute extras evenly
    max_passes = 4
    for _pass in range(max_passes):
        order = list(range(sector_count))
        random.shuffle(order)
        changed_any = False
        for s in order:
            # Skip extras for sealed nodes to preserve cul-de-sacs
            if s in SEALED:
                continue
            desired_out = desired_map[s]
            if len(warps_outgoing[s]) >= desired_out:
                continue
            if und_deg[s] >= DEGREE_CAP_UND:
                continue
            # Build candidates excluding existing edges, self, and sealed nodes; also degree-cap filtered
            base = set(range(sector_count)) - {s} - warps_outgoing[s] - SEALED
            base = {t for t in base if und_deg[t] < DEGREE_CAP_UND}
            if not base:
                continue
            # Sort candidates with locality bias and degree fairness
            def key_t(t):
                dr = abs(ring.get(s, 0) - ring.get(t, 0))
                ldepth = lca_depth(s, t)
                closeness = max(0, min(depth.get(s,0), depth.get(t,0)) - ldepth)
                return (0 if dr <= 1 else 1, closeness, und_deg[t], random.random())
            candidates = sorted(list(base), key=key_t)
            added_this_node = False
            for t in candidates:
                if len(warps_outgoing[s]) >= desired_out:
                    break
                if und_deg[t] >= DEGREE_CAP_UND:
                    continue
                # Hard reject long chords and far subtrees
                dr = abs(ring.get(s, 0) - ring.get(t, 0))
                if dr > 1:
                    continue
                ldepth = lca_depth(s, t)
                closeness = max(0, min(depth.get(s,0), depth.get(t,0)) - ldepth)
                if closeness > 1:
                    continue
                # Avoid creating triangles to keep clustering low
                if any((u in und_adj[t]) for u in und_adj[s]):
                    continue
                # Add directed s->t
                warps_outgoing[s].add(t)
                und_adj[s].add(t)
                und_adj[t].add(s)
                und_deg[s] += 1
                und_deg[t] += 1
                # With probability, add reverse to make two-way
                if random.random() < TWO_WAY_PROBABILITY and und_deg[s] < DEGREE_CAP_UND and und_deg[t] < DEGREE_CAP_UND:
                    warps_outgoing[t].add(s)
                changed_any = True
                added_this_node = True
                break  # at most one per pass per node to spread edges
        if not changed_any:
            break

    # Undirected neighbors (after extras)
    undirected_neighbors = [set() for _ in range(sector_count)]
    for s in range(sector_count):
        for t in warps_outgoing[s]:
            undirected_neighbors[s].add(t)
            undirected_neighbors[t].add(s)
    undirected_neighbors = [sorted(neis) for neis in undirected_neighbors]

    # Actual two-way arc fraction (for meta)
    total_arcs = sum(len(v) for v in warps_outgoing.values())
    two_way_arcs = sum(
        1
        for s in range(sector_count)
        for t in warps_outgoing[s]
        if s in warps_outgoing.get(t, ())
    )
    actual_two_way_arc_fraction = (two_way_arcs / total_arcs) if total_arcs else 0.0

    # Count two-hop cul-de-sacs preserved after extras
    def is_culdesac(triple) -> bool:
        a, u, v = triple
        return (
            len(undirected_neighbors[u]) == 2 and a in undirected_neighbors[u] and v in undirected_neighbors[u]
            and len(undirected_neighbors[v]) == 1 and u in undirected_neighbors[v]
        )
    culdesacs = sum(1 for tri in selected_triples if is_culdesac(tri))

    # --- Port placement (exact count to hit density target) ---
    target_port_count = round(PORT_PERCENTAGE * sector_count)
    degrees = [len(neis) for neis in undirected_neighbors]
    # Prefer low-degree locations for ports (leaves/near-leaves first)
    all_sectors = list(range(sector_count))
    all_sectors.sort(key=lambda s: (degrees[s], random.random()))
    port_sectors = set(all_sectors[:target_port_count])

    # Assign random classes initially
    port_class_by_sector = {s: random.randint(1, 8) for s in port_sectors}

    # Complementary-pair encouragement (optional)
    def coverage_fraction() -> float:
        if not port_class_by_sector:
            return 0.0
        ok = 0
        for s, cls in port_class_by_sector.items():
            comp = complement_class(cls)
            in_range = bfs_within_radius(
                s, undirected_neighbors, COMPLEMENTARY_PAIR_RADIUS
            )
            if any(
                (n in port_class_by_sector) and (port_class_by_sector[n] == comp)
                for n in in_range
            ):
                ok += 1
        return ok / len(port_class_by_sector)

    if ENSURE_COMPLEMENTARY_PAIRS and port_class_by_sector:
        for _ in range(MAX_PAIR_TUNING_PASSES):
            lacking = []
            for s, cls in port_class_by_sector.items():
                comp = complement_class(cls)
                in_range = bfs_within_radius(
                    s, undirected_neighbors, COMPLEMENTARY_PAIR_RADIUS
                )
                if not any(
                    (n in port_class_by_sector) and (port_class_by_sector[n] == comp)
                    for n in in_range
                ):
                    lacking.append(s)
            random.shuffle(lacking)
            for s in lacking:
                # Flip s to complement *someone* nearby if possible
                candidates = [
                    n
                    for n in bfs_within_radius(
                        s, undirected_neighbors, COMPLEMENTARY_PAIR_RADIUS
                    )
                    if n in port_class_by_sector and n != s
                ]
                random.shuffle(candidates)
                for t in candidates:
                    desired = complement_class(port_class_by_sector[t])
                    if port_class_by_sector[s] != desired:
                        port_class_by_sector[s] = desired
                        break
            if coverage_fraction() >= COMPLEMENTARY_PAIR_COVERAGE:
                break

    actual_pair_coverage = coverage_fraction()

    # --- Planet placement (MVP: disabled) ---
    planet_sectors = set()
    if GENERATE_PLANETS and PLANET_PERCENTAGE > 0:
        target_planet_count = round(PLANET_PERCENTAGE * sector_count)
        # Deterministic pick based on shuffled list
        remaining = [s for s in all_sectors if s not in port_sectors] + [
            s for s in all_sectors if s in port_sectors
        ]
        planet_sectors = set(remaining[:target_planet_count])

    # --- Build universe_structure.json ---
    universe_structure = {
        "meta": {
            "sector_count": sector_count,
            "id_base": 0,
            "directed": True,
            "seed": seed,
            "warp_outgoing_range": [MIN_WARPS_PER_SECTOR, MAX_WARPS_PER_SECTOR],
            "two_way_probability_setting": TWO_WAY_PROBABILITY,
            "actual_two_way_arc_fraction": round(actual_two_way_arc_fraction, 3),
            "course_length_hint": COURSE_LENGTH_HINT,
            "rare_spurs": {
                "target": RARE_SPUR_TARGET,
                "selected": len(selected_triples),
                "preserved": culdesacs,
                "min_sep": RARE_SPUR_MIN_SEP,
                "degree_cap": DEGREE_CAP_UND,
            },
        },
        "sectors": [],
    }
    for s in range(sector_count):
        warps = [
            {"to": t, "two_way": (s in warps_outgoing[t])}
            for t in sorted(warps_outgoing[s])
        ]
        universe_structure["sectors"].append({"id": s, "warps": warps})

    # --- Build sector_contents.json ---
    contents_meta = {
        "sector_count": sector_count,
        "seed": seed,
        "base_port_density": BASE_PORT_DENSITY,
        "initial_port_build_rate": INITIAL_PORT_BUILD_RATE,
        "port_percentage_effective": round(PORT_PERCENTAGE, 3),
        "planets_enabled": GENERATE_PLANETS,
        "planet_percentage": PLANET_PERCENTAGE,
        "complementary_pairs": {
            "enabled": ENSURE_COMPLEMENTARY_PAIRS,
            "radius": COMPLEMENTARY_PAIR_RADIUS,
            "target_coverage": COMPLEMENTARY_PAIR_COVERAGE,
            "actual_coverage": round(actual_pair_coverage, 3),
        },
        # Hints for your runtime pricing/regen systems
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
        "commodities": COM_LONG,  # QF/RO/NS labels for readability
    }

    sector_contents_list = []
    next_planet_id = 0

    for s in range(sector_count):
        port = None
        planets = []

        if s in port_class_by_sector:
            port = build_port_object(
                port_class_by_sector[s],
                default_cap=PORT_DEFAULT_CAP,
                start_fill=PORT_STARTING_FILL,
            )

        if GENERATE_PLANETS and s in planet_sectors:
            planets.append(build_planet_object(next_planet_id))
            next_planet_id += 1

        sector_contents_list.append(
            {
                "id": s,
                "port": port,
                "planets": planets,  # empty when GENERATE_PLANETS=False
            }
        )

    universe_contents = {"meta": contents_meta, "sectors": sector_contents_list}

    # --- Write files ---
    with open("universe_structure.json", "w") as f:
        json.dump(universe_structure, f, indent=2)
    with open("sector_contents.json", "w") as f:
        json.dump(universe_contents, f, indent=2)

    print(f"Generated universe with {sector_count} sectors (0-indexed).")
    print("Two-way arcs (actual): {p:.1%}".format(p=actual_two_way_arc_fraction))
    print(
        "Complementary pair coverage (actual): {c:.1%}".format(c=actual_pair_coverage)
    )
    print(f"Two-hop cul-de-sacs preserved: {culdesacs} (target {RARE_SPUR_TARGET})")
    print("Files created: universe_structure.json, sector_contents.json")


if __name__ == "__main__":
    main()
