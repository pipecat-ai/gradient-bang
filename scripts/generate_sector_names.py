#!/usr/bin/env python3
"""Generate world-data/sector_names.json — run once, commit the output.

Produces 5000 unique sector names mixing 2-word and 3-word forms.
All names are environment-agnostic; megaport grand names are applied at
load time by load_universe_to_supabase.py based on meta.mega_port_sectors.

2-word: "Adj Noun"            (e.g. "Iron Gate")
3-word: "Adj Adj Noun"        (e.g. "Frozen Iron Gate")

Seeded with 42 for reproducibility.
"""
import json
import random
from pathlib import Path

ADJECTIVES = [
    "Amber", "Ancient", "Arctic", "Ashen", "Astral", "Atomic", "Azure",
    "Barren", "Basalt", "Binary", "Bismuth", "Blazing", "Bleeding",
    "Blinking", "Broken", "Burning", "Buried", "Cascading", "Celestial",
    "Cerulean", "Charred", "Chrome", "Cinder", "Cobalt", "Colossal",
    "Copper", "Coral", "Corrupt", "Cosmic", "Crashing", "Crimson",
    "Cryogenic", "Crystal", "Cursed", "Dark", "Dawnlit", "Decayed",
    "Deep", "Derelict", "Diamond", "Distant", "Drifting", "Dusk",
    "Dying", "Echo", "Eclipse", "Electric", "Ember", "Eternal", "Faded",
    "Fading", "Fallen", "Feral", "Flux", "Forgotten", "Fractal",
    "Fractured", "Freezing", "Frozen", "Fused", "Galactic", "Garnet",
    "Ghost", "Gilded", "Glacial", "Glass", "Gleaming", "Gloomy",
    "Glowing", "Golden", "Granite", "Graphite", "Gravitational", "Grey",
    "Halo", "Hazed", "Helios", "Hex", "Hidden", "High", "Hollow",
    "Humming", "Hyperion", "Icy", "Igneous", "Indigo", "Infinite",
    "Ion", "Iridium", "Iron", "Ivory", "Jade", "Kepler", "Kinetic",
    "Kyanite", "Latent", "Lazuli", "Lightless", "Liminal", "Lost",
    "Lunar", "Lurking", "Magnetic", "Marble", "Maroon", "Mercury",
    "Meridian", "Meteor", "Midnight", "Misty", "Molten", "Moonless",
    "Muted", "Mystic", "Nebula", "Neon", "Nether", "Nova", "Null",
    "Obscure", "Obsidian", "Oblivion", "Omega", "Onyx", "Open", "Orion",
    "Outer", "Pale", "Pandora", "Phantom", "Photon", "Plasma",
    "Plutonian", "Polaris", "Primordial", "Pristine", "Proxima",
    "Pulsar", "Pure", "Quantum", "Quartz", "Quasar", "Quicksilver",
    "Quiet", "Radiant", "Red", "Rift", "Rogue", "Royal", "Ruinous",
    "Rusted", "Sapphire", "Scarlet", "Scorched", "Searing", "Shadow",
    "Shattered", "Shifting", "Silent", "Silver", "Skylit", "Sleeping",
    "Slipstream", "Smoldering", "Solar", "Spectral", "Splintered",
    "Starfall", "Starless", "Steel", "Stellar", "Storm", "Sunken",
    "Sunless", "Sunstone", "Swift", "Tainted", "Terminal", "Thermal",
    "Titan", "Torn", "Tranquil", "Turquoise", "Twilight", "Umbra",
    "Umbral", "Unbroken", "Unstable", "Vacant", "Vanished", "Velvet",
    "Venomous", "Verdant", "Vermillion", "Violet", "Viridian",
    "Volatile", "Voltaic", "Vortex", "Waning", "Warped", "Whispering",
    "Wraith", "Xenon", "Zenith", "Zero",
]

NOUNS = [
    "Abyss", "Aether", "Anchorage", "Anomaly", "Approach", "Arch",
    "Archipelago", "Array", "Ascent", "Asteroid", "Atlas", "Atoll",
    "Aurora", "Axis", "Basin", "Bastion", "Bay", "Beacon", "Belt",
    "Bolt", "Breach", "Breakwater", "Bridge", "Bulwark", "Cairn",
    "Canyon", "Cape", "Cascade", "Causeway", "Cavern", "Cay", "Chamber",
    "Channel", "Chasm", "Chord", "Circuit", "Citadel", "Cluster",
    "Coast", "Column", "Confluence", "Conjunction", "Constellation",
    "Core", "Corridor", "Cosmos", "Cradle", "Crater", "Crest",
    "Crossing", "Crown", "Crucible", "Current", "Delta", "Descent",
    "Divide", "Dock", "Dome", "Domain", "Drift", "Edge", "Enclave",
    "Equinox", "Escarpment", "Expanse", "Eye", "Fathom", "Field",
    "Flare", "Flats", "Fold", "Forge", "Fork", "Fountain", "Fringe",
    "Front", "Galaxy", "Gate", "Gateway", "Genesis", "Glade", "Glen",
    "Gorge", "Grid", "Grotto", "Gulch", "Gulf", "Harbor", "Haven",
    "Heart", "Helm", "Highlands", "Horizon", "Hub", "Ingress", "Inlet",
    "Isle", "Junction", "Kessel", "Keystone", "Knoll", "Labyrinth",
    "Lagoon", "Landing", "Lane", "Lattice", "Ledge", "Lens", "Limit",
    "Line", "Link", "Lock", "Locus", "Loop", "Magnet", "Manifold",
    "March", "Mark", "Matrix", "Maze", "Meridian", "Mesa", "Mire",
    "Mound", "Nadir", "Narrows", "Needle", "Network", "Nexus", "Node",
    "Notch", "Obelisk", "Observatory", "Orbit", "Outpost", "Overlook",
    "Palisade", "Pantheon", "Parallax", "Parapet", "Pass", "Passage",
    "Path", "Pavilion", "Peak", "Perimeter", "Phalanx", "Pillar",
    "Pinnacle", "Pit", "Pivot", "Plain", "Plateau", "Platform", "Point",
    "Port", "Post", "Precipice", "Promontory", "Pulse", "Pyramid",
    "Quay", "Rampart", "Ravine", "Reach", "Refuge", "Relay",
    "Reliquary", "Remnant", "Reservoir", "Ribbon", "Ridge", "Rim",
    "Ring", "Rise", "Roost", "Route", "Run", "Sanctuary", "Scar",
    "Shallows", "Shelf", "Shore", "Silhouette", "Sink", "Sliver",
    "Slope", "Sound", "Span", "Spine", "Spur", "Stairway", "Stand",
    "Starfield", "Station", "Storehouse", "Strait", "Strand", "Stream",
    "Summit", "Terminal", "Theater", "Thicket", "Threshold", "Tidepool",
    "Torrent", "Tower", "Tract", "Trench", "Trough", "Tundra",
    "Undertow", "Vale", "Valley", "Vault", "Veil", "Vein", "Vertex",
    "Vigil", "Vista", "Volcano", "Warren", "Waypoint", "Weir", "Wharf",
    "Wildwood", "Woodland", "Zenith", "Zone",
]

TARGET = 5000
ADJ_POOL = 200
NOUN_POOL = 200
THREE_WORD_RATE = 0.35  # ~35% of names get an extra adjective

# Word banks carry extra entries for future headroom; we use a fixed pool size
# so a reload with the same seed produces the same universe.
assert len(ADJECTIVES) >= ADJ_POOL, f"need >={ADJ_POOL} adjectives, got {len(ADJECTIVES)}"
assert len(NOUNS) >= NOUN_POOL, f"need >={NOUN_POOL} nouns, got {len(NOUNS)}"
assert len(set(ADJECTIVES)) == len(ADJECTIVES), "duplicate adjectives"
assert len(set(NOUNS)) == len(NOUNS), "duplicate nouns"

ADJECTIVES = ADJECTIVES[:ADJ_POOL]
NOUNS = NOUNS[:NOUN_POOL]

random.seed(42)
seen: set[str] = set()
out: list[str] = []

# Keep sampling until we have TARGET unique names. With 200*200=40k 2-word
# and ~200*199*200=~8M 3-word combinations, 5000 unique picks is trivial.
while len(out) < TARGET:
    if random.random() < THREE_WORD_RATE:
        a1, a2 = random.sample(ADJECTIVES, 2)
        noun = random.choice(NOUNS)
        name = f"{a1} {a2} {noun}"
    else:
        name = f"{random.choice(ADJECTIVES)} {random.choice(NOUNS)}"
    if name in seen:
        continue
    seen.add(name)
    out.append(name)

out_path = Path(__file__).parent.parent / "world-data" / "sector_names.json"
out_path.write_text(json.dumps(out) + "\n")
print(f"✅ Wrote {len(out)} sector names to {out_path}")

three_word = sum(1 for n in out if n.count(" ") == 2)
print(f"   2-word: {len(out) - three_word}")
print(f"   3-word: {three_word}")
print(f"   samples: {out[0]!r}, {out[len(out)//2]!r}, {out[-1]!r}")
