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

import sys, json, random
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
MAX_WARPS_PER_SECTOR = 4
TWO_WAY_PROBABILITY = 0.30  # raise to 0.5-0.7 for friendlier maps

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
    "FO": "fuel_ore",
    "OG": "organics",
    "EQ": "equipment",
}  # labels for readability

# Port class (1..8) -> code ("B"/"S") for FO, OG, EQ
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
    stock = {"FO": 0, "OG": 0, "EQ": 0}
    stock_max = {"FO": 0, "OG": 0, "EQ": 0}
    demand = {"FO": 0, "OG": 0, "EQ": 0}
    demand_max = {"FO": 0, "OG": 0, "EQ": 0}

    buys, sells = [], []
    for com, idx in (("FO", 0), ("OG", 1), ("EQ", 2)):
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

    # --- Build a connected directed graph (warps) ---
    warps_outgoing = {s: set() for s in range(sector_count)}

    # Spanning connectivity (two-way link from each new node to a prior node)
    for s in range(1, sector_count):
        t = random.randint(0, s - 1)
        warps_outgoing[s].add(t)
        warps_outgoing[t].add(s)

    # Extra warps: mix of one-way/two-way
    for s in range(sector_count):
        desired_out = random.randint(MIN_WARPS_PER_SECTOR, MAX_WARPS_PER_SECTOR)
        if len(warps_outgoing[s]) >= desired_out:
            continue
        candidates = list(set(range(sector_count)) - {s} - warps_outgoing[s])
        random.shuffle(candidates)
        for t in candidates:
            if len(warps_outgoing[s]) >= desired_out:
                break
            warps_outgoing[s].add(t)
            if random.random() < TWO_WAY_PROBABILITY:
                warps_outgoing[t].add(s)

    # Undirected neighbors (for hop calculations)
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

    # --- Port placement (exact count to hit density target) ---
    target_port_count = round(PORT_PERCENTAGE * sector_count)
    all_sectors = list(range(sector_count))
    random.shuffle(all_sectors)
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
        "commodities": COM_LONG,  # FO/OG/EQ labels for readability
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
    print("Files created: universe_structure.json, sector_contents.json")


if __name__ == "__main__":
    main()
