import os
import subprocess
import time
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_PATH = REPO_ROOT / '.env.supabase'
_CLI_ENV = os.environ.get('SUPABASE_CLI')
if _CLI_ENV:
    CLI_PATH = _CLI_ENV if Path(_CLI_ENV).exists() else None
else:
    from shutil import which

    CLI_PATH = which('supabase')
    if CLI_PATH is None:
        default_candidate = Path('/usr/local/bin/supabase')
        if default_candidate.exists():
            CLI_PATH = str(default_candidate)


def _load_env() -> None:
    if not ENV_PATH.exists():
        raise RuntimeError(
            '.env.supabase is missing – run supabase start and create the file before running edge tests'
        )

    with ENV_PATH.open() as env_file:
        for line in env_file:
            stripped = line.strip()
            if not stripped or stripped.startswith('#'):
                continue
            if '=' not in stripped:
                continue
            key, value = stripped.split('=', 1)
            os.environ.setdefault(key, value)


def _stack_running() -> bool:
    if CLI_PATH is None:
        return False

    result = subprocess.run(
        [CLI_PATH, 'status', '--output', 'json'],
        capture_output=True,
        check=False,
        text=True,
    )
    return result.returncode == 0


def _start_stack() -> None:
    if CLI_PATH is None:
        raise RuntimeError('Supabase CLI is not installed or not on PATH')

    proc = subprocess.Popen(
        [CLI_PATH, 'start'],
        cwd=str(REPO_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    if not proc.stdout:
        raise RuntimeError('Failed to capture supabase start output')

    ready_markers = {'API URL': False, 'Studio URL': False}
    timeout = 180.0
    start_time = time.time()

    for line in proc.stdout:
        for marker in ready_markers:
            if marker in line:
                ready_markers[marker] = True
        if all(ready_markers.values()):
            break
        if time.time() - start_time > timeout:
            proc.terminate()
            raise RuntimeError('Timed out waiting for supabase start to finish')

    proc.wait(timeout=30)


@pytest.fixture(scope='session', autouse=True)
def supabase_stack():
    """Ensure a Supabase local stack is up before edge tests run."""

    if CLI_PATH is None:
        pytest.skip('Supabase CLI not available; skipping edge tests')

    _load_env()
    if not _stack_running():
        _start_stack()

    yield
