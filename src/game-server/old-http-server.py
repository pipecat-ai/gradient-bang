#!/usr/bin/env python3
"""
Gradient Bang HTTP server - thin FastAPI app delegating to api modules.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from world import world, lifespan
from api import (
    plot_course as api_plot_course,
    join as api_join,
    move as api_move,
    my_status as api_my_status,
    my_map as api_my_map,
    local_map as api_local_map,
    check_trade as api_check_trade,
    trade as api_trade,
    recharge_warp_power as api_recharge,
    transfer_warp_power as api_transfer,
    reset_ports as api_reset_ports,
    regenerate_ports as api_regen_ports,
)


app = FastAPI(title="Gradient Bang", version="0.1.0", lifespan=lifespan)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8080", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    return {
        "name": "Gradient Bang",
        "version": "0.1.0",
        "status": "running",
        "sectors": world.universe_graph.sector_count if world.universe_graph else 0,
    }


@app.post("/api/plot_course")
async def plot_course(request: dict):
    return await api_plot_course.handle(request, world)


@app.post("/api/join")
async def join(request: dict):
    return await api_join.handle(request, world)


@app.post("/api/move")
async def move(request: dict):
    return await api_move.handle(request, world)


@app.post("/api/my_status")
async def my_status(request: dict):
    return await api_my_status.handle(request, world)


@app.post("/api/my_map")
async def my_map(request: dict):
    return await api_my_map.handle(request, world)


@app.post("/api/local_map")
async def local_map(request: dict):
    return await api_local_map.handle(request, world)


@app.get("/api/local_map")
async def local_map_get(center: int = 0, max_hops: int = 3, max_nodes: int = 25):
    """Get local map data for visualization without character context."""
    from collections import deque

    if not world.universe_graph:
        return {"node_list": []}

    # BFS to find nodes within max_hops
    visited = set()
    queue = deque([(center, 0)])
    nodes_by_id = {}

    while queue and len(nodes_by_id) < max_nodes:
        sector_id, distance = queue.popleft()

        # Skip if already visited or too far
        if sector_id in visited or distance > max_hops:
            continue

        visited.add(sector_id)

        # Get adjacency info
        adjacent_sectors = world.universe_graph.adjacency.get(sector_id, [])
        if sector_id not in world.universe_graph.adjacency:
            continue

        # Check for port
        port_type = None
        if world.port_manager:
            port_state = world.port_manager.load_port_state(sector_id)
            if port_state:
                port_type = port_state.code

        # Store node info
        nodes_by_id[sector_id] = {
            "id": sector_id,
            "visited": True,  # For demo, all nodes are "visited"
            "port_type": port_type,
            "adjacent": adjacent_sectors
        }

        # Add neighbors to queue
        if distance < max_hops:
            for neighbor_id in adjacent_sectors:
                if neighbor_id not in visited:
                    queue.append((neighbor_id, distance + 1))

    # Filter adjacency lists to only include nodes in our result set
    node_list = []
    for node_id in sorted(nodes_by_id.keys()):
        node = nodes_by_id[node_id]
        node["adjacent"] = [adj for adj in node["adjacent"] if adj in nodes_by_id]
        node_list.append(node)

    return {"node_list": node_list}


@app.post("/api/check_trade")
async def check_trade(request: dict):
    return await api_check_trade.handle(request, world)


@app.post("/api/trade")
async def trade(request: dict):
    return await api_trade.handle(request, world)


@app.post("/api/recharge_warp_power")
async def recharge_warp_power(request: dict):
    return await api_recharge.handle(request, world)


@app.post("/api/transfer_warp_power")
async def transfer_warp_power(request: dict):
    return await api_transfer.handle(request, world)


@app.post("/api/reset_ports")
async def reset_ports():
    return await api_reset_ports.handle({}, world)


@app.post("/api/regenerate_ports")
async def regenerate_ports(request: dict):
    return await api_regen_ports.handle(request, world)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
