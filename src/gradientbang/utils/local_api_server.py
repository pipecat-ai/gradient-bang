"""Launch and manage a local Deno API server for edge functions."""

from __future__ import annotations

import asyncio
import os
import subprocess

import httpx
from loguru import logger

LOCAL_API_PORT = int(os.getenv("LOCAL_API_PORT", "54380"))
HEALTH_CHECK_TIMEOUT = 30  # seconds
HEALTH_CHECK_INTERVAL = 0.5  # seconds


def _resolve_edge_functions_dir() -> str:
    """Resolve the edge functions directory.

    Priority:
    1. EDGE_FUNCTIONS_DIR env var (explicit override)
    2. /app/edge-functions (Docker container path)
    3. deployment/supabase/functions/ relative to repo root (local dev)
    """
    explicit = os.getenv("EDGE_FUNCTIONS_DIR")
    if explicit:
        return explicit

    # Docker path
    docker_path = "/app/edge-functions"
    if os.path.isdir(docker_path):
        return docker_path

    # Walk up from this file to find the repo root (contains deployment/)
    current = os.path.dirname(os.path.abspath(__file__))
    for _ in range(10):
        candidate = os.path.join(current, "deployment", "supabase", "functions")
        if os.path.isdir(candidate):
            return candidate
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent

    return docker_path  # fallback


class LocalApiServer:
    """Manages a Deno subprocess serving all edge functions."""

    def __init__(self) -> None:
        self._process: subprocess.Popen | None = None
        self._port = LOCAL_API_PORT

    @property
    def url(self) -> str:
        return f"http://localhost:{self._port}"

    async def start(self) -> str:
        """Start the Deno server and wait for it to be ready.

        Returns the base URL of the local server.
        """
        edge_functions_dir = _resolve_edge_functions_dir()
        server_ts = os.path.join(edge_functions_dir, "server.ts")
        if not os.path.exists(server_ts):
            raise FileNotFoundError(
                f"Edge function server not found at {server_ts}. "
                f"Set EDGE_FUNCTIONS_DIR to the path containing server.ts."
            )

        deno_json = os.path.join(edge_functions_dir, "deno.json")
        logger.info(f"Starting local API server on port {self._port}...")

        env = {**os.environ, "LOCAL_API_PORT": str(self._port)}

        # Pass LOCAL_API_POSTGRES_URL as POSTGRES_POOLER_URL to the Deno
        # subprocess (that's the env var _shared/pg.ts reads).
        pg_url = os.getenv("LOCAL_API_POSTGRES_URL")
        if pg_url:
            env["POSTGRES_POOLER_URL"] = pg_url

        cmd = ["deno", "run", "--allow-net", "--allow-env", "--allow-read"]
        if os.path.exists(deno_json):
            cmd.append(f"--import-map={deno_json}")
        cmd.append(server_ts)

        self._process = subprocess.Popen(
            cmd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )

        # Drain subprocess output in background thread
        asyncio.get_event_loop().run_in_executor(None, self._drain_output)

        await self._wait_for_ready()

        logger.info(f"Local API server ready at {self.url}")
        return self.url

    async def _wait_for_ready(self) -> None:
        """Poll the health endpoint until the server responds."""
        deadline = asyncio.get_event_loop().time() + HEALTH_CHECK_TIMEOUT
        async with httpx.AsyncClient() as client:
            while asyncio.get_event_loop().time() < deadline:
                if self._process and self._process.poll() is not None:
                    raise RuntimeError(
                        f"Local API server exited with code {self._process.returncode}"
                    )
                try:
                    resp = await client.get(f"{self.url}/health", timeout=2.0)
                    if resp.status_code == 200:
                        data = resp.json()
                        logger.info(
                            f"Local API server healthy: {data.get('functions', '?')} functions loaded"
                        )
                        return
                except (httpx.ConnectError, httpx.ReadError, httpx.TimeoutException):
                    pass
                await asyncio.sleep(HEALTH_CHECK_INTERVAL)

        raise TimeoutError(
            f"Local API server did not become ready within {HEALTH_CHECK_TIMEOUT}s"
        )

    def _drain_output(self) -> None:
        """Read subprocess stdout in a background thread and log it."""
        if not self._process or not self._process.stdout:
            return
        for line in self._process.stdout:
            line = line.rstrip()
            if line:
                logger.info(f"[local-api] {line}")

    async def stop(self) -> None:
        """Terminate the Deno server subprocess."""
        if self._process:
            logger.info("Stopping local API server...")
            self._process.terminate()
            try:
                self._process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait(timeout=2)
            self._process = None
            logger.info("Local API server stopped")
