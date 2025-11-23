import os
import pytest

from scripts import ci_admin_smoke

pytestmark = pytest.mark.edge


@pytest.mark.asyncio
async def test_supabase_admin_smoke():
    os.environ.setdefault("SUPABASE_ALLOW_LEGACY_IDS", "1")
    await ci_admin_smoke.run_smoke("edge-smoke", sector=0)
