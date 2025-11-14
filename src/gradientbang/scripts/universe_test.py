#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.9"
# dependencies = [
#     "networkx",
# ]
# ///
"""
Test script to validate universe connectivity and identify issues.
Checks for:
- Unreachable sectors
- Trap clusters (can enter but not leave)
- Isolated components
- Dead ends (sectors with no outgoing warps)
- One-way traps

Usage:
  ./test_universe.py [path_to_universe_structure.json]
  
  Or with default path:
  ./test_universe.py
"""

import json
import sys
from pathlib import Path
from collections import deque
import networkx as nx
from gradientbang.utils.config import get_world_data_path


def load_universe_data():
    """Load universe structure from JSON file."""
    filepath = get_world_data_path() / "universe_structure.json"
    
    path = Path(filepath)
    if not path.exists():
        print(f"Error: File not found: {filepath}")
        sys.exit(1)
    
    with open(path, 'r') as f:
        return json.load(f)


def build_graph(universe_data):
    """Build NetworkX directed graph from universe data."""
    G = nx.DiGraph()
    
    # Add all sectors as nodes
    for sector in universe_data['sectors']:
        G.add_node(sector['id'])
    
    # Add warps as edges
    for sector in universe_data['sectors']:
        for warp in sector.get('warps', []):
            G.add_edge(sector['id'], warp['to'])
    
    return G


def _map_edges(universe_data):
    """Map edges to their warp dicts for quick lookup."""
    edges = {}
    for sector in universe_data['sectors']:
        u = sector['id']
        for warp in sector.get('warps', []):
            v = warp['to']
            edges[(u, v)] = warp
    return edges


def find_two_way_inconsistencies(universe_data):
    """Find cases where two_way flags don't match mutual adjacency."""
    edges = _map_edges(universe_data)
    problems = []
    checked_pairs = set()
    for (u, v), info_uv in edges.items():
        pair = (min(u, v), max(u, v))
        if pair in checked_pairs:
            continue
        checked_pairs.add(pair)
        uv = (u, v)
        vu = (v, u)
        has_uv = uv in edges
        has_vu = vu in edges
        flag_uv = edges[uv]['two_way'] if has_uv else None
        flag_vu = edges[vu]['two_way'] if has_vu else None
        # Expectations:
        # - If both directions exist, both flags must be True
        # - If only one direction exists, its two_way must be False
        if has_uv and has_vu:
            if not (flag_uv and flag_vu):
                problems.append(("mutual_edges_not_flagged_two_way", uv, vu, flag_uv, flag_vu))
        elif has_uv and not has_vu:
            if flag_uv:
                problems.append(("one_way_flagged_two_way", uv, None, flag_uv, None))
        elif has_vu and not has_uv:
            if flag_vu:
                problems.append(("one_way_flagged_two_way", vu, None, flag_vu, None))
    return problems


def find_dead_ends(universe_data):
    """Find sectors with no outgoing warps."""
    dead_ends = []
    
    for sector in universe_data['sectors']:
        if not sector.get('warps') or len(sector['warps']) == 0:
            dead_ends.append(sector['id'])
    
    return dead_ends


def find_unreachable_from_start(G, start_sector=0):
    """Find all sectors unreachable from a given starting sector."""
    reachable = set()
    queue = deque([start_sector])
    
    while queue:
        current = queue.popleft()
        if current in reachable:
            continue
        reachable.add(current)
        
        # Add all neighbors to queue
        for neighbor in G.successors(current):
            if neighbor not in reachable:
                queue.append(neighbor)
    
    all_sectors = set(G.nodes())
    unreachable = all_sectors - reachable
    
    return list(unreachable)


def find_trap_clusters(G):
    """Find clusters of sectors that can be entered but not exited."""
    # A trap cluster is a strongly connected component that has
    # incoming edges but no outgoing edges to other SCCs
    
    sccs = list(nx.strongly_connected_components(G))
    condensation = nx.condensation(G, sccs)
    
    trap_clusters = []
    
    for scc_idx, scc_nodes in enumerate(sccs):
        # Check if this SCC has outgoing edges in the condensation graph
        out_degree = condensation.out_degree(scc_idx)
        in_degree = condensation.in_degree(scc_idx)
        
        # If it has incoming edges but no outgoing edges, it's a trap
        if in_degree > 0 and out_degree == 0:
            trap_clusters.append(list(scc_nodes))
    
    return trap_clusters


def find_isolated_clusters(G):
    """Find completely isolated clusters with no connections in or out."""
    # If the graph is strongly connected, there cannot be any isolated clusters
    if nx.is_strongly_connected(G):
        return []
    
    # These are weakly connected components that have zero edges to/from outside
    weakly_connected = list(nx.weakly_connected_components(G))
    # If there's only one weakly connected component (the whole graph), nothing is isolated
    if len(weakly_connected) <= 1:
        return []
    
    isolated = []
    for wcc in weakly_connected:
        if len(wcc) > 1:
            # Check if this component is disconnected from the rest
            # Count edges going in/out of this component
            external_edges_in = 0
            external_edges_out = 0
            
            for node in wcc:
                # Check incoming edges from outside
                for pred in G.predecessors(node):
                    if pred not in wcc:
                        external_edges_in += 1
                
                # Check outgoing edges to outside
                for succ in G.successors(node):
                    if succ not in wcc:
                        external_edges_out += 1
            
            if external_edges_in == 0 and external_edges_out == 0:
                isolated.append(list(wcc))
    
    return isolated


def check_strong_connectivity(G):
    """Check if the graph is strongly connected."""
    return nx.is_strongly_connected(G)


def find_weakly_connected_only(G):
    """Find pairs of sectors that are only connected by one-way warps."""
    problems = []
    
    for node in G.nodes():
        for successor in G.successors(node):
            # Check if there's a path back
            if not nx.has_path(G, successor, node):
                # Check how many nodes are reachable from successor
                reachable_from_successor = nx.descendants(G, successor)
                reachable_from_successor.add(successor)
                
                # Check if we can get back to node from any of them
                can_return = False
                for reachable in reachable_from_successor:
                    if nx.has_path(G, reachable, node):
                        can_return = True
                        break
                
                if not can_return:
                    problems.append((node, successor))
    
    return problems


def analyze_universe():
    """Run all connectivity tests on the universe using the default world-data path."""
    print(f"\n{'='*60}")
    print("UNIVERSE CONNECTIVITY ANALYSIS")
    print(f"{'='*60}\n")

    # Load data from the standard universe_structure.json path
    filepath = get_world_data_path() / "universe_structure.json"
    print(f"Loading universe data from: {filepath}")
    universe_data = load_universe_data()
    
    # Build graph
    G = build_graph(universe_data)
    
    print(f"Universe has {G.number_of_nodes()} sectors and {G.number_of_edges()} warps\n")
    
    # Run tests
    all_good = True
    
    # Test 1: Dead ends
    print("1. Checking for dead ends (sectors with no outgoing warps)...")
    dead_ends = find_dead_ends(universe_data)
    if dead_ends:
        print(f"   ❌ Found {len(dead_ends)} dead end(s): {dead_ends[:10]}{'...' if len(dead_ends) > 10 else ''}")
        all_good = False
    else:
        print("   ✅ No dead ends found")
    
    # Test 2: Strong connectivity
    print("\n2. Checking strong connectivity...")
    if check_strong_connectivity(G):
        print("   ✅ Graph is strongly connected (all sectors reachable from all others)")
    else:
        print("   ❌ Graph is NOT strongly connected")
        sccs = list(nx.strongly_connected_components(G))
        print(f"   Found {len(sccs)} strongly connected components")
        print(f"   Largest component has {len(max(sccs, key=len))} sectors")
        print(f"   Smallest components: {[len(scc) for scc in sorted(sccs, key=len)[:5]]}")
        all_good = False
    
    # Test 3: Unreachable from sector 0
    print("\n3. Checking for sectors unreachable from sector 0...")
    unreachable = find_unreachable_from_start(G, 0)
    if unreachable:
        print(f"   ❌ Found {len(unreachable)} unreachable sector(s): {unreachable[:10]}{'...' if len(unreachable) > 10 else ''}")
        all_good = False
    else:
        print("   ✅ All sectors reachable from sector 0")
    
    # Test 4: Trap clusters
    print("\n4. Checking for trap clusters (can enter but not leave)...")
    trap_clusters = find_trap_clusters(G)
    if trap_clusters:
        print(f"   ❌ Found {len(trap_clusters)} trap cluster(s):")
        for i, cluster in enumerate(trap_clusters[:5]):
            print(f"      Cluster {i+1}: {len(cluster)} sectors - {cluster[:5]}{'...' if len(cluster) > 5 else ''}")
        if len(trap_clusters) > 5:
            print(f"      ... and {len(trap_clusters)-5} more")
        all_good = False
    else:
        print("   ✅ No trap clusters found")
    
    # Test 5: Isolated clusters
    print("\n5. Checking for completely isolated clusters...")
    isolated = find_isolated_clusters(G)
    if isolated:
        print(f"   ❌ Found {len(isolated)} isolated cluster(s):")
        for i, cluster in enumerate(isolated[:5]):
            print(f"      Cluster {i+1}: {cluster[:10]}{'...' if len(cluster) > 10 else ''}")
        all_good = False
    else:
        print("   ✅ No isolated clusters found")
    
    # Test 6: Graph statistics
    print("\n6. Graph Statistics:")
    print(f"   Average out-degree: {sum(G.out_degree(n) for n in G.nodes()) / G.number_of_nodes():.2f}")
    print(f"   Average in-degree: {sum(G.in_degree(n) for n in G.nodes()) / G.number_of_nodes():.2f}")
    
    # Count two-way connections
    two_way = 0
    one_way = 0
    for sector in universe_data['sectors']:
        for warp in sector.get('warps', []):
            if warp.get('two_way'):
                two_way += 1
            else:
                one_way += 1
    
    print(f"   Two-way warps: {two_way}")
    print(f"   One-way warps: {one_way}")
    print(f"   Ratio: {two_way/(two_way+one_way)*100:.1f}% two-way")
    
    # Test for hyperlanes if they exist
    hyperlane_count = 0
    for sector in universe_data['sectors']:
        for warp in sector.get('warps', []):
            if warp.get('is_hyperlane'):
                hyperlane_count += 1
    
    if hyperlane_count > 0:
        print(f"   Hyperlanes: {hyperlane_count // 2} pairs")  # Divided by 2 since they're two-way
    
    # Test 7: two_way flag consistency
    print("\n7. Verifying two_way flag consistency...")
    tw_issues = find_two_way_inconsistencies(universe_data)
    if tw_issues:
        print(f"   ❌ Found {len(tw_issues)} two_way inconsistencies (showing up to 10):")
        for entry in tw_issues[:10]:
            kind, uv, vu, fuv, fvu = entry
            print(f"      {kind}: {uv} {vu} flags=({fuv},{fvu})")
        all_good = False
    else:
        print("   ✅ two_way flags are consistent with mutual links")
    
    # Final verdict
    print(f"\n{'='*60}")
    if all_good:
        print("✅ UNIVERSE PASSED ALL CONNECTIVITY TESTS!")
    else:
        print("❌ UNIVERSE HAS CONNECTIVITY ISSUES - See above for details")
    print(f"{'='*60}\n")
    
    return all_good


def main():
    """Main entry point."""
    success = analyze_universe()
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()