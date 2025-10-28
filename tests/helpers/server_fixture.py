"""
Server lifecycle management for integration tests.

This module provides utilities for starting, stopping, and managing test servers
during integration tests.
"""

import asyncio
import subprocess
import signal
import time
from pathlib import Path
from typing import Optional
import httpx


def start_test_server(
    port: int = 8002,
    world_data_dir: str = "tests/test-world-data",
    timeout: float = 10.0
) -> subprocess.Popen:
    """
    Start a test server subprocess.

    Args:
        port: Port to run the server on (default: 8002)
        world_data_dir: Path to the world data directory
        timeout: Maximum time to wait for server to start (seconds)

    Returns:
        subprocess.Popen: The running server process

    Raises:
        RuntimeError: If server fails to start within timeout
    """
    # Kill any existing server on this port to ensure fresh start
    try:
        result = subprocess.run(
            ["lsof", "-ti", f":{port}"],
            capture_output=True,
            text=True,
            timeout=2.0
        )
        if result.stdout.strip():
            pids = result.stdout.strip().split('\n')
            for pid in pids:
                try:
                    subprocess.run(["kill", "-9", pid], timeout=1.0)
                except Exception:
                    pass
            # Wait a moment for ports to be released
            time.sleep(0.5)
    except Exception:
        # lsof might not be available, continue anyway
        pass

    project_root = Path(__file__).parent.parent.parent
    game_server_path = project_root / "game-server"

    # Set environment variables for the server
    env = {
        "PORT": str(port),
        "WORLD_DATA_DIR": world_data_dir,
        "PYTHONUNBUFFERED": "1",  # Ensure output is not buffered
    }

    # Start the server process (log output to file for debugging)
    log_file = project_root / "logs" / f"test-server-{port}.log"
    log_file.parent.mkdir(parents=True, exist_ok=True)
    log_handle = open(log_file, "w")

    process = subprocess.Popen(
        ["uv", "run", "python", "-m", "game-server"],
        cwd=str(project_root),
        env={**subprocess.os.environ, **env},
        stdout=log_handle,
        stderr=subprocess.STDOUT,  # Merge stderr into stdout
    )

    # Store log handle on process object for cleanup
    process._log_handle = log_handle

    return process


def stop_test_server(process: subprocess.Popen, timeout: float = 5.0) -> None:
    """
    Gracefully stop a test server process.

    Sends SIGTERM first, waits for graceful shutdown. If process doesn't
    terminate within timeout, sends SIGKILL.

    Args:
        process: The server process to stop
        timeout: Maximum time to wait for graceful shutdown (seconds)
    """
    if process.poll() is not None:
        # Process already terminated
        return

    # Try graceful shutdown first
    process.terminate()

    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        # Force kill if graceful shutdown fails
        process.kill()
        process.wait()

    # Close log file handle if present
    if hasattr(process, '_log_handle'):
        process._log_handle.close()


async def wait_for_server_ready(url: str, timeout: float = 10.0, process: Optional[subprocess.Popen] = None) -> None:
    """
    Poll the server health endpoint until it's ready or timeout.

    Args:
        url: Base URL of the server (e.g., "http://localhost:8002")
        timeout: Maximum time to wait for server to be ready (seconds)
        process: Optional server process to check for crashes

    Raises:
        RuntimeError: If server doesn't become ready within timeout
    """
    # Use root endpoint for health check (server doesn't have /health)
    health_url = url if url.endswith("/") else f"{url}/"
    start_time = time.time()

    async with httpx.AsyncClient() as client:
        while time.time() - start_time < timeout:
            # Check if process has crashed
            if process and process.poll() is not None:
                raise RuntimeError(
                    f"Server process crashed with exit code {process.returncode}\n"
                    f"Check that WORLD_DATA_DIR is valid and contains required files"
                )

            try:
                response = await client.get(health_url, timeout=1.0)
                if response.status_code == 200:
                    return
            except (httpx.ConnectError, httpx.TimeoutException):
                pass

            await asyncio.sleep(0.5)

    # If we timeout, provide helpful error message
    error_msg = f"Server at {url} did not become ready within {timeout} seconds"
    if process and process.poll() is None:
        # Server is still running but not responding
        error_msg += "\nServer process is running but not responding to health checks"
    elif process and process.poll() is not None:
        error_msg += f"\nServer crashed with exit code {process.returncode}"

    raise RuntimeError(error_msg)


def copy_test_world_data(dest_dir: str) -> None:
    """
    Copy test world data to a destination directory for isolation.

    This allows tests to modify test data without affecting other test runs
    or the original test data files.

    Args:
        dest_dir: Destination directory to copy test data to

    Note:
        This function uses shell commands for efficient directory copying.
    """
    import shutil

    source_dir = Path(__file__).parent.parent / "test-world-data"
    dest_path = Path(dest_dir)

    # Remove existing destination if it exists
    if dest_path.exists():
        shutil.rmtree(dest_path)

    # Copy test data
    shutil.copytree(source_dir, dest_path)
