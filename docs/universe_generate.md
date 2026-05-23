# Universe Generation

The Gradient Bang universe is a graph of sectors connected by warps. A single Python script — [universe_bang.py](../src/gradientbang/scripts/universe_bang.py) — generates the whole thing deterministically from a sector count and a seed, and writes it to `universe.json`. That file is the only source of truth for the world's shape; the game server loads it as-is.

## What the universe is made of

- **Sectors.** The atomic unit of space. Each sector has an `(x, y)` position on a hex grid, a region (Federation Space or Neutral), an optional port, and a deterministic scene config used by the client.
- **Warps.** Directed edges between sectors. Most are two-way, but a meaningful fraction are one-way so the topology has texture and traps. A backbone MST guarantees the graph is connected.
- **Ports.** Trade stations. Each port `buys` and `sells` a fixed mix of the three commodities (`quantum_foam`, `retro_organics`, `neuro_symbolics`), based on its class (BBS, BSB, etc.).
- **Mega-ports.** Three special ports in Federation Space with massively oversized stock and demand. These are the economic anchors of the map.
- **Federation Space (Fedspace).** A connected cluster of 75 sectors near the graph center, distinguished from Neutral space. New players spawn here; the megaports live here.

## How it's generated

1. **Hex grid.** A square hex grid is built large enough to hold the requested sector count comfortably (`grid_size ≈ √(4·sector_count)`).
2. **Sector placement.** Sectors are sampled uniformly from grid positions, snapped to integer coords. This gives an even spatial distribution rather than clusters.
3. **Warp graph.** A Delaunay triangulation over the sector positions defines candidate edges. Each edge is kept as one-way or two-way based on length and probability. An MST is overlaid as a fully two-way backbone so the universe is always traversable.
4. **Connectivity repair.** Disconnected components are joined to the main component, and sectors with very limited reachability get some of their outgoing edges promoted to two-way.
5. **Fedspace.** The graph center (the sector with smallest eccentricity) is picked, and Fedspace grows outward from it via BFS until it has 75 connected sectors.
6. **Ports.** Around 38% of sectors get a port, biased mildly toward high-degree "crossroads" sectors and away from dead ends. Port classes are then nudged so most ports have a complementary trade partner within 2 warps — this is what makes trade routes feasible.
7. **Mega-ports.** Three sectors inside Fedspace are chosen to be mutually far apart in the warp graph, so the economic anchors are spread across Fedspace rather than clumped.
8. **Validation.** Before writing, the universe is run through [universe_test.py](../src/gradientbang/scripts/universe_test.py) — connectivity, reachability, Fedspace integrity, port pairing coverage, etc.

## Visualizing

Use [universe_svg.py](../src/gradientbang/scripts/universe_svg.py) to render a generated `universe.json` as an SVG. Fedspace, mega-ports, port classes, and one-way warps are all visually distinguished — this is the fastest way to sanity-check a generation.

## Primary levers

These are the knobs that change the feel of the universe. Most live as constants at the top of [universe_bang.py](../src/gradientbang/scripts/universe_bang.py).

### Sector count

Passed as a CLI argument — `uv run python -m gradientbang.scripts.universe_bang <sector_count> [seed]`. This is the single biggest dial. It changes:

- The size of the map and how spread out Fedspace feels relative to the whole.
- The number of ports (roughly 38% of sectors).
- How far typical trade routes are between mega-ports and the frontier.

Fedspace is a fixed 75 sectors regardless of total size, so larger universes have a proportionally smaller Federation core and more Neutral frontier.

### Seed

Optional second CLI argument. Same seed + same sector count + same constants → identical universe. Different seeds produce structurally similar but spatially different worlds: same density rules, same Fedspace size, but the center sits in a different place, the warp graph has different bottlenecks, and ports cluster differently.

### Fedspace size (`FEDSPACE_SECTOR_COUNT`)

Currently 75. Raising it makes the safe starting region larger and the frontier feel smaller; lowering it makes Neutral space dominate sooner. Mega-ports must fit inside Fedspace, so this can't go below `MEGA_PORT_COUNT`.

### Mega-port count and stock (`MEGA_PORT_COUNT`, `MEGA_PORT_STOCK_MULTIPLIER`)

Three mega-ports each carry 10× the max regular port capacity per commodity (`PORT_MAX_CAP · 10` = 100k units). They're the economic anchors. Adding more mega-ports spreads economic activity; raising the multiplier makes them harder to drain and more dominant relative to regular trade.

### Port density (`BASE_PORT_DENSITY`, `INITIAL_PORT_BUILD_RATE`)

Effective port percentage is `0.40 · 0.95 = 38%` of sectors. Higher density means more trade options per jump and shorter routes; lower density makes route discovery and longer hauls matter more.

### Port inventory (`PORT_MIN_CAP`, `PORT_MAX_CAP`, regen fractions)

Regular ports get a random per-commodity capacity in `[1000, 10000]`. Sell stock starts full, buy demand starts empty. Regeneration restores 25% of max stock and 25% of max demand per tick. Raising caps and regen makes ports more forgiving for traders; lowering them creates real scarcity.

### Warp shape

- `MAX_DELAUNAY_EDGE_LENGTH` (3.5) — longer warps than this are dropped, so jumps stay spatially short.
- `DEGREE_CAP` (6) — no sector can have more than 6 outgoing warps; prevents super-hubs.
- `TWO_WAY_PROBABILITY_ADJACENT` (0.7) / `TWO_WAY_PROBABILITY_DISTANT` (0.3) — controls how many warps are reversible. Lowering these makes one-way traps more common and exploration riskier.

### Complementary port pairing

`COMPLEMENTARY_PAIR_RADIUS` (2) and `COMPLEMENTARY_PAIR_COVERAGE` (0.70) control how aggressively the generator nudges port classes so ≥70% of ports have a complementary trade partner within 2 warps. Lowering coverage makes the trade landscape sparser and more uneven; raising it produces a tighter, more predictable trade economy.

## When to regenerate

Universe regeneration is destructive — it writes a new `universe.json` and downstream tools (`load_universe_to_supabase.py`) replace the world. The script refuses to overwrite unless `--force` is passed. In practice you regenerate when:

- You're tuning the levers above and want to see the effect.
- You want a fresh seed for a new test or playthrough.
- You're changing sector count or Fedspace topology.

For day-to-day gameplay tweaks (commodity prices, ship stats, etc.) you do **not** want to regenerate — those live elsewhere.
