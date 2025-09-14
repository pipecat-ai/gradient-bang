#!/usr/bin/env python3
"""Serve local_map.html and reverse-proxy /api/* to the game server.

Bind address: 0.0.0.0:8080
Backend API:  http://0.0.0.0:8000

Usage:
  uv run scripts/serve_local_map.py

Notes:
  - By serving the HTML and proxy from the same origin, the browser does not
    need CORS allowances from the FastAPI backend.
  - This is intentionally tiny and only proxies HTTP requests (no websockets).
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, Response, PlainTextResponse
from fastapi.staticfiles import StaticFiles
import uvicorn


HOST = "0.0.0.0"
PORT = 8080
BACKEND = "http://0.0.0.0:8000"


app = FastAPI(title="Local Map Host+Proxy")


ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "local_map.html"
HTML_CLAUDE = ROOT / "local_map_claude.html"
HTML_GOLDEN = ROOT / "local_map_golden.html"
GRAPH_LAYOUT_JS = ROOT / "graph_layout.js"


@app.get("/")
async def index():
    if not HTML.exists():
        return PlainTextResponse(f"local_map.html not found at {HTML}", status_code=404)
    # Modest cache so reloads pick up changes quickly
    return FileResponse(str(HTML), headers={"cache-control": "no-cache"})


@app.get("/local_map.html")
async def html_alias():
    return await index()


@app.get("/local_map_claude.html")
async def claude_version():
    if not HTML_CLAUDE.exists():
        return PlainTextResponse(
            f"local_map_claude.html not found at {HTML_CLAUDE}", status_code=404
        )
    # Modest cache so reloads pick up changes quickly
    return FileResponse(str(HTML_CLAUDE), headers={"cache-control": "no-cache"})


@app.get("/local_map_golden.html")
async def golden_version():
    if not HTML_GOLDEN.exists():
        return PlainTextResponse(
            f"local_map_golden.html not found at {HTML_GOLDEN}", status_code=404
        )
    # Modest cache so reloads pick up changes quickly
    return FileResponse(str(HTML_GOLDEN), headers={"cache-control": "no-cache"})


@app.get("/graph_layout.js")
async def graph_layout_js():
    if not GRAPH_LAYOUT_JS.exists():
        return PlainTextResponse(f"graph_layout.js not found at {GRAPH_LAYOUT_JS}", status_code=404)
    # Serve the JavaScript module
    return FileResponse(
        str(GRAPH_LAYOUT_JS),
        headers={"cache-control": "no-cache", "content-type": "application/javascript"},
    )


@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/local_map")
async def local_map(center: int = 0, max_hops: int = 3):
    """Serve local map data from world-data files.

    This endpoint reads the world-data JSON files and returns
    nodes within max_hops of the center sector.
    """
    import json
    from collections import deque

    # Load the universe data
    universe_file = ROOT / "world-data" / "universe_structure.json"
    if not universe_file.exists():
        return PlainTextResponse(
            f"universe_structure.json not found at {universe_file}", status_code=404
        )

    with open(universe_file) as f:
        universe = json.load(f)

    # Get all sectors - it's a list, convert to dict for easy lookup
    sectors_list = universe.get("sectors", [])
    sectors = {s["id"]: s for s in sectors_list}

    # Load sector contents for port information
    contents_file = ROOT / "world-data" / "sector_contents.json"
    sector_contents = {}
    if contents_file.exists():
        with open(contents_file) as f:
            contents_data = json.load(f)
            contents_list = contents_data.get("sectors", [])
            sector_contents = {s["id"]: s for s in contents_list}

    # BFS to find nodes within max_hops
    visited = set()
    queue = deque([(center, 0)])  # (sector_id, distance)
    nodes = []

    while queue:
        sector_id, distance = queue.popleft()

        # Skip if already visited or too far
        if sector_id in visited or distance > max_hops:
            continue

        visited.add(sector_id)

        # Get sector data
        if sector_id not in sectors:
            continue

        sector_data = sectors[sector_id]

        # Extract adjacent sectors from warps list
        adjacent = []
        for warp in sector_data.get("warps", []):
            if isinstance(warp, dict) and "to" in warp:
                adjacent.append(warp["to"])

        # Get port type from sector contents
        port_type = None
        if sector_id in sector_contents:
            sector_content = sector_contents[sector_id]
            if sector_content.get("port"):
                port_type = sector_content["port"].get("code")

        # Add node to result
        node = {
            "id": sector_id,
            "visited": True,  # For testing, mark all as visited
            "port_type": port_type,
            "adjacent": adjacent,
        }
        nodes.append(node)

        # Add adjacent sectors to queue
        if distance < max_hops:
            for adjacent_id in adjacent:
                if adjacent_id not in visited:
                    queue.append((adjacent_id, distance + 1))

    return {"node_list": nodes}


# Serve world-data/* directly for the "Use world data (global)" option
WORLD_DIR = ROOT / "world-data"
if WORLD_DIR.exists():
    app.mount("/world-data", StaticFiles(directory=str(WORLD_DIR), html=False), name="world-data")


@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def api_proxy(path: str, request: Request):
    url = f"{BACKEND}/api/{path}"

    # Preserve query params and body
    params: Dict[str, str] = dict(request.query_params)
    body = await request.body()

    # Pass headers except Host
    headers = {k: v for k, v in request.headers.items() if k.lower() != "host"}

    async with httpx.AsyncClient() as client:
        upstream = await client.request(
            request.method, url, params=params, content=body, headers=headers
        )

    # Reflect status and content-type back to the browser
    content_type = upstream.headers.get("content-type", "application/json")
    return Response(
        upstream.content, status_code=upstream.status_code, headers={"content-type": content_type}
    )


def main():
    print(f"Serving {HTML} at http://{HOST}:{PORT}")
    print(f"Proxying /api/* to {BACKEND}")
    uvicorn.run(app, host=HOST, port=PORT)


if __name__ == "__main__":
    main()
