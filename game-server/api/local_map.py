from collections import deque, defaultdict
from fastapi import HTTPException


def _build_known_graph(knowledge) -> tuple[set[int], dict[int, set[int]]]:
    """Return (known_nodes, directed_adjacency) from character knowledge.

    - known_nodes includes all visited sectors and any sectors referenced by
      visited sectors' outbound links (seen-but-not-visited).
    - directed_adjacency contains only edges we actually know about: outbound
      links from visited sectors.
    """
    visited_ids: set[int] = set()
    directed: dict[int, set[int]] = defaultdict(set)

    # knowledge.sectors_visited is a dict[str, SectorKnowledge]
    for _, sector_knowledge in knowledge.sectors_visited.items():
        sid = int(sector_knowledge.sector_id)
        visited_ids.add(sid)
        for nb in sector_knowledge.adjacent_sectors or []:
            directed[sid].add(int(nb))

    known_nodes = set(visited_ids)
    for src, nbs in directed.items():
        known_nodes.add(src)
        known_nodes.update(nbs)

    return known_nodes, directed


def _bfs_undirected(
    center: int,
    directed: dict[int, set[int]],
    *,
    max_hops: int | None = None,
    max_nodes: int | None = None,
):
    """Undirected BFS over the known directed graph with optional limits.

    We treat an undirected neighbor relation as existing if either src->dst or
    dst->src is known (based solely on player knowledge).

    Returns (included_set, distance_map, traversal_order) where traversal order
    preserves the BFS discovery sequence (useful when applying node limits).
    """
    undirected: dict[int, set[int]] = defaultdict(set)
    for a, nbs in directed.items():
        for b in nbs:
            undirected[a].add(b)
            undirected[b].add(a)

    if center not in undirected:
        # Include isolated center; player may have extremely limited knowledge
        undirected.setdefault(center, set())

    dist: dict[int, int] = {center: 0}
    order: list[int] = [center]
    q = deque([center])

    while q and (max_nodes is None or len(dist) < max_nodes):
        cur = q.popleft()
        if max_hops is not None and dist[cur] >= max_hops:
            continue
        for nb in undirected.get(cur, ()):  # noqa: WPS335 (small loop)
            if nb not in dist:
                dist[nb] = dist[cur] + 1
                q.append(nb)
                order.append(nb)
                if max_nodes is not None and len(dist) >= max_nodes:
                    break

    return set(dist.keys()), dist, order


async def handle(request: dict, world) -> dict:
    """Build a local, player-known subgraph around a center sector.

    Request fields:
      - character_id: str (required)
      - current_sector: int (optional; default to live/persisted sector)
      - max_hops: int (optional) – number of rings to include
      - max_sectors: int (optional) – cap on number of nodes to return

    If both `max_hops` and `max_sectors` are provided, `max_sectors` takes
    precedence.

    Response shape (minimal by design):
      {
        "node_list": [
          {"id": int, "visited": bool, "port_type": str|None, "adjacent": [int, ...]},
        ]
      }
    """
    if not world.universe_graph:
        raise HTTPException(status_code=503, detail="Game world not loaded")

    character_id = request.get("character_id")
    if not character_id:
        raise HTTPException(status_code=400, detail="Missing character_id")

    max_sectors = request.get("max_sectors")
    max_hops = request.get("max_hops")

    effective_max_hops: int | None
    max_nodes: int | None = None

    if max_sectors is not None:
        try:
            max_nodes = int(max_sectors)
            if max_nodes <= 0:
                raise ValueError
        except Exception:
            raise HTTPException(status_code=422, detail="max_sectors must be a positive integer")
        effective_max_hops = None
    else:
        if max_hops is None:
            raise HTTPException(status_code=400, detail="Missing max_hops")
        try:
            converted = int(max_hops)
            if converted < 0:
                raise ValueError
        except Exception:
            raise HTTPException(status_code=422, detail="max_hops must be a non-negative integer")
        effective_max_hops = converted

    # Load knowledge and determine center sector
    knowledge = world.knowledge_manager.load_knowledge(character_id)
    center = request.get("current_sector")
    if center is None:
        # Prefer live sector if connected
        if character_id in world.characters:
            center = world.characters[character_id].sector
        else:
            center = knowledge.current_sector if knowledge.current_sector is not None else 0

    # Build known directed graph from player knowledge
    known_nodes, directed = _build_known_graph(knowledge)

    # Ensure the center is included even if we somehow lack adjacency
    known_nodes.add(int(center))

    # Limit to a radius using undirected BFS over known edges
    included, _, _ = _bfs_undirected(
        int(center),
        directed,
        max_hops=effective_max_hops,
        max_nodes=max_nodes,
    )

    # Constrain to nodes we actually know about (visited or seen)
    included &= known_nodes

    # Emit nodes with filtered adjacency (only edges to included nodes)
    node_list = []
    visited_keys = set(int(k) for k in knowledge.sectors_visited.keys())
    for nid in sorted(included):
        visited = nid in visited_keys
        port_type = None
        if visited:
            sk = knowledge.sectors_visited[str(nid)]
            port_info = getattr(sk, "port", None)
            if port_info:
                port_type = port_info.get("code")
        adj = [int(t) for t in directed.get(nid, set()) if t in included]
        node_list.append({
            "id": int(nid),
            "visited": bool(visited),
            "port_type": port_type,
            "adjacent": adj,
        })

    response: dict = {"node_list": node_list}
    if max_nodes is not None:
        response["max_sectors"] = max_nodes
    elif effective_max_hops is not None:
        response["max_hops"] = effective_max_hops

    return response
