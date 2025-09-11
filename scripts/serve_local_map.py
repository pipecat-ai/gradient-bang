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

import asyncio
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


@app.get("/")
async def index():
    if not HTML.exists():
        return PlainTextResponse(
            f"local_map.html not found at {HTML}", status_code=404
        )
    # Modest cache so reloads pick up changes quickly
    return FileResponse(str(HTML), headers={"cache-control": "no-cache"})


@app.get("/local_map.html")
async def html_alias():
    return await index()


@app.get("/health")
async def health():
    return {"ok": True}

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
    return Response(upstream.content, status_code=upstream.status_code, headers={"content-type": content_type})


def main():
    print(f"Serving {HTML} at http://{HOST}:{PORT}")
    print(f"Proxying /api/* to {BACKEND}")
    uvicorn.run(app, host=HOST, port=PORT)


if __name__ == "__main__":
    main()
