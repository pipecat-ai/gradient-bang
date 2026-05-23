"""Fixtures for integration tests that need a running Supabase instance.

These fixtures are only active when pytest is invoked via
scripts/run-integration-tests.sh, which exports the required env vars.
"""

import os

import httpx
import pytest

from gradientbang.utils.supabase_client import AsyncGameClient


@pytest.fixture(scope="session")
def supabase_url(test_supabase_env):
    """Test Supabase API URL."""
    return test_supabase_env["SUPABASE_URL"]


@pytest.fixture(scope="session")
def edge_functions_url(supabase_url):
    """Edge function base URL.

    Prefers the standalone server.ts on EDGE_FUNCTIONS_URL (started by the
    integration harness with ALLOW_AUTH_BYPASS_FOR_LOCAL_DEV=1) so admin-only
    endpoints like test_reset succeed without an EDGE_API_TOKEN. Falls back
    to the Supabase gateway path.
    """
    base = os.environ.get("EDGE_FUNCTIONS_URL")
    if base:
        return base.rstrip("/")
    return f"{supabase_url}/functions/v1"


@pytest.fixture(scope="session")
def supabase_anon_key(test_supabase_env):
    """Test Supabase anonymous key."""
    return test_supabase_env["SUPABASE_ANON_KEY"]


@pytest.fixture(scope="session")
def supabase_service_role_key(test_supabase_env):
    """Test Supabase service role key."""
    return test_supabase_env["SUPABASE_SERVICE_ROLE_KEY"]


@pytest.fixture(scope="class")
async def reset_db(edge_functions_url, supabase_service_role_key):
    """Reset the test database via the test_reset edge function.

    Truncates all tables and re-seeds the 10-sector test universe.
    Runs once per test class.
    """
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{edge_functions_url}/test_reset",
            json={"character_ids": []},
            headers={
                "Content-Type": "application/json",
                "apikey": supabase_service_role_key,
                "Authorization": f"Bearer {supabase_service_role_key}",
            },
        )
        assert resp.status_code == 200, f"test_reset failed ({resp.status_code}): {resp.text}"
        data = resp.json()
        assert data.get("success"), f"test_reset returned failure: {data}"

    return data


@pytest.fixture(scope="class")
async def reset_db_with_characters(edge_functions_url, supabase_service_role_key):
    """Factory fixture: reset DB and create specific test characters.

    Usage:
        @pytest.fixture(autouse=True)
        async def setup(self, reset_db_with_characters):
            await reset_db_with_characters(["test_py_p1", "test_py_p2"])
    """

    async def _reset(character_ids: list[str]):
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{edge_functions_url}/test_reset",
                json={"character_ids": character_ids},
                headers={
                    "Content-Type": "application/json",
                    "apikey": supabase_service_role_key,
                    "Authorization": f"Bearer {supabase_service_role_key}",
                },
            )
            assert resp.status_code == 200, f"test_reset failed ({resp.status_code}): {resp.text}"
            data = resp.json()
            assert data.get("success"), f"test_reset returned failure: {data}"
            return data

    return _reset


@pytest.fixture
def make_game_client(supabase_url, edge_functions_url):
    """Factory fixture that creates AsyncGameClient instances pointed at the test instance.

    The client reads SUPABASE_URL, SUPABASE_ANON_KEY, and EDGE_API_TOKEN from
    env vars, which are already set by run-integration-tests.sh.
    """
    clients = []

    def _make(character_id: str, **kwargs):
        kwargs.setdefault("enable_event_polling", False)
        client = AsyncGameClient(
            base_url=supabase_url,
            functions_url=edge_functions_url,
            character_id=character_id,
            **kwargs,
        )
        # Increase HTTP timeout for integration tests (edge function cold starts)
        import httpx as _httpx

        client._http = _httpx.AsyncClient(timeout=30.0)
        clients.append(client)
        return client

    yield _make

    # Cleanup: close all httpx sessions
    for c in clients:
        if hasattr(c, "_http") and c._http is not None:
            import asyncio

            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    loop.create_task(c._http.aclose())
                else:
                    loop.run_until_complete(c._http.aclose())
            except Exception:
                pass
