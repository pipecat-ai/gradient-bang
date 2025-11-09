import logging
import os
import shlex
import subprocess
import time
from pathlib import Path
from typing import Dict, IO, Optional, Tuple

import httpx
import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_PATH = REPO_ROOT / '.env.supabase'
LOG_DIR = REPO_ROOT / 'logs'
SUPABASE_CLIENT_LOG_PATH = LOG_DIR / 'supabase-client.log'
ENV_EXPORTS: Dict[str, str] = {}


def _resolve_cli_command() -> list[str] | None:
    env_cmd = os.environ.get('SUPABASE_CLI_COMMAND')
    if env_cmd:
        return shlex.split(env_cmd)

    env_path = os.environ.get('SUPABASE_CLI')
    if env_path and Path(env_path).exists():
        return [env_path]

    from shutil import which

    direct = which('supabase')
    if direct:
        return [direct]

    # Fallback to npx invocation (works even without global install)
    if which('npx'):
        return ['npx', 'supabase@latest']

    return None


CLI_COMMAND = _resolve_cli_command()
FUNCTION_PROC: Optional[Tuple[subprocess.Popen[str], IO[str]]] = None
FUNCTIONS_UNDER_TEST = (
    'join',
    'my_status',
    'move',
    'local_map_region',
    'list_known_ports',
    'plot_course',
    'trade',
    'path_with_region',
    'recharge_warp_power',
    'transfer_warp_power',
    'dump_cargo',
    'transfer_credits',
    'bank_transfer',
    'purchase_fighters',
    'ship_purchase',
    'combat_initiate',
    'combat_action',
    'combat_tick',
    'event_query',
    'test_reset',
)


def _edge_url() -> str:
    base = os.environ.get('SUPABASE_URL', 'http://127.0.0.1:54321')
    return os.environ.get('EDGE_FUNCTIONS_URL', f"{base.rstrip('/')}/functions/v1")


def _load_env() -> Dict[str, str]:
    if not ENV_PATH.exists():
        raise RuntimeError(
            '.env.supabase is missing – run supabase start and create the file before running edge tests'
        )

    env_vars = {}
    with ENV_PATH.open() as env_file:
        for line in env_file:
            stripped = line.strip()
            if not stripped or stripped.startswith('#'):
                continue
            if '=' not in stripped:
                continue
            key, value = stripped.split('=', 1)
            env_vars[key] = value

    os.environ.update(env_vars)
    ENV_EXPORTS.update(env_vars)
    return env_vars


def _run_cli(*args: str, check: bool = False):
    if CLI_COMMAND is None:
        raise RuntimeError('Supabase CLI is not available. Install supabase or set SUPABASE_CLI_COMMAND.')

    return subprocess.run(
        [*CLI_COMMAND, *args],
        capture_output=True,
        text=True,
        check=check,
    )


def _stack_running() -> bool:
    if CLI_COMMAND is None:
        return False

    result = _run_cli('status', '--output', 'json')
    return result.returncode == 0


def _start_stack() -> None:
    if CLI_COMMAND is None:
        raise RuntimeError('Supabase CLI is not available; cannot start local stack')

    proc = subprocess.Popen(
        [*CLI_COMMAND, 'start'],
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


def _reset_database() -> None:
    if CLI_COMMAND is None or os.environ.get('SUPABASE_SKIP_DB_RESET') == '1':
        return

    result = _run_cli('--yes', 'db', 'reset')
    if result.returncode != 0:
        raise RuntimeError(f'Supabase db reset failed: {result.stderr or result.stdout}')


def _function_available(name: str) -> bool:
    api_token = os.environ.get('EDGE_API_TOKEN') or os.environ.get('SUPABASE_API_TOKEN', '')
    try:
        resp = httpx.post(
            f"{_edge_url().rstrip('/')}/{name}",
            headers={'Content-Type': 'application/json', 'x-api-token': api_token},
            json={'healthcheck': True},
            timeout=5.0,
        )
    except httpx.HTTPError:
        return False

    if resp.status_code == 404 and resp.text.strip() == 'Function not found':
        return False
    if resp.status_code >= 500:
        return False

    try:
        payload = resp.json()
    except ValueError:
        return False

    if payload.get('status') != 'ok':
        return False
    return bool(payload.get('token_present'))


def _write_function_env(name: str) -> Path:
    allowed = {k: v for k, v in ENV_EXPORTS.items() if not k.startswith('SUPABASE_')}
    env_file = LOG_DIR / f'.edge-env-{name}'
    with env_file.open('w') as handle:
        for key, value in allowed.items():
            handle.write(f"{key}={value}\n")
    return env_file


def _cleanup_edge_container() -> None:
    container_name = os.environ.get('SUPABASE_EDGE_RUNTIME_CONTAINER', 'supabase_edge_runtime_gb-supa')
    result = subprocess.run(
        ['docker', 'rm', '-f', container_name],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 and 'No such container' not in result.stderr:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with open(LOG_DIR / 'edge-container-cleanup.log', 'a', buffering=1) as handle:
            handle.write(f"[pytest] docker rm -f {container_name} failed: {result.stderr}\n")


def _ensure_functions_served(names: Tuple[str, ...]) -> None:
    global FUNCTION_PROC

    if FUNCTION_PROC:
        if all(_function_available(name) for name in names):
            return
        _stop_functions_proc()

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / 'edge-functions.log'
    log_handle = open(log_path, 'a', buffering=1)
    log_handle.write('[pytest] launching supabase functions serve (all functions)\n')

    _cleanup_edge_container()

    env_file = _write_function_env('functions')
    cmd = [*CLI_COMMAND, 'functions', 'serve', '--env-file', str(env_file), '--no-verify-jwt']
    env = os.environ.copy()
    proc = subprocess.Popen(
        cmd,
        cwd=str(REPO_ROOT),
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
    )
    FUNCTION_PROC = (proc, log_handle)

    deadline = time.time() + 120
    while time.time() < deadline:
        if all(_function_available(name) for name in names):
            return
        if proc.poll() is not None:
            raise RuntimeError(
                f'Edge functions serve exited early. Check logs at {log_path} for diagnostics.'
            )
        time.sleep(1)

    _stop_functions_proc()
    raise RuntimeError(
        f'Edge functions did not become available. Check logs at {log_path} for diagnostics.'
    )


def _stop_functions_proc() -> None:
    global FUNCTION_PROC
    if FUNCTION_PROC is None:
        return
    proc, handle = FUNCTION_PROC
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
    handle.close()
    FUNCTION_PROC = None


def _realtime_debug_enabled() -> bool:
    return os.environ.get('SUPABASE_REALTIME_DEBUG', '').lower() in {'1', 'true', 'on'}


@pytest.fixture(scope='session', autouse=True)
def supabase_stack():
    """Ensure a Supabase local stack is up before edge tests run."""

    if CLI_COMMAND is None:
        pytest.skip('Supabase CLI not available; install it or set SUPABASE_CLI_COMMAND="npx supabase@latest"')

    _load_env()
    if not _stack_running():
        _start_stack()
    _reset_database()

    _ensure_functions_served(FUNCTIONS_UNDER_TEST)

    try:
        yield
    finally:
        _stop_functions_proc()


@pytest.fixture(scope='session', autouse=True)
def supabase_client_logging():
    if not _realtime_debug_enabled():
        # Enable by exporting SUPABASE_REALTIME_DEBUG=1 before running pytest.
        yield None
        return

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    handler = logging.FileHandler(SUPABASE_CLIENT_LOG_PATH, mode='w')
    formatter = logging.Formatter('[%(asctime)s] %(levelname)s %(name)s: %(message)s')
    handler.setFormatter(formatter)
    handler.setLevel(logging.DEBUG)

    logger = logging.getLogger('utils.supabase_client')
    previous_level = logger.level
    logger.setLevel(logging.DEBUG)
    logger.addHandler(handler)
    os.environ['SUPABASE_CLIENT_LOG'] = str(SUPABASE_CLIENT_LOG_PATH)

    try:
        yield SUPABASE_CLIENT_LOG_PATH
    finally:
        logger.removeHandler(handler)
        handler.close()
        logger.setLevel(previous_level)
        os.environ.pop('SUPABASE_CLIENT_LOG', None)


@pytest.fixture(scope='session', autouse=True)
def test_server():
    """Override the global async test_server fixture for edge tests."""
    yield


@pytest.fixture(autouse=True)
def reset_test_state():
    """Edge tests talk directly to Supabase so no FastAPI reset is needed."""
    yield
