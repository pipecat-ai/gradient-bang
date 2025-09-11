#!/usr/bin/env python3
"""
Gradient Bang HTTP server - thin FastAPI app delegating to api modules.
"""

from fastapi import FastAPI

from core.world import world, lifespan
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
