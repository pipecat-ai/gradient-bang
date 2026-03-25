"""Root conftest for Gradient Bang tests.

Provides session-scoped fixtures for integration tests that need a running
Supabase instance. The test Supabase is started by scripts/run-integration-tests.sh
which exports credentials as environment variables before invoking pytest.
"""

import os

import pytest


@pytest.fixture(scope="session")
def test_supabase_env():
    """Read test Supabase config from env vars set by run-integration-tests.sh.

    Skips all integration tests if the env vars aren't present (i.e. pytest
    was invoked directly rather than through the integration test script).
    """
    url = os.environ.get("SUPABASE_URL", "")
    anon_key = os.environ.get("SUPABASE_ANON_KEY", "")
    service_role_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

    # The integration script sets SUPABASE_URL to the test instance (port 54421).
    # If we're pointing at the dev instance (54321) or env is empty, skip.
    if not url or ":54421" not in url:
        pytest.skip(
            "Not running in integration test environment. "
            "Use: bash scripts/run-integration-tests.sh"
        )

    if not anon_key or not service_role_key:
        pytest.skip("Missing SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY")

    return {
        "SUPABASE_URL": url,
        "SUPABASE_ANON_KEY": anon_key,
        "SUPABASE_SERVICE_ROLE_KEY": service_role_key,
    }
