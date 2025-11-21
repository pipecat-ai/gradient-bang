import asyncio
import logging
import os
import shlex
import subprocess
import time
from contextlib import suppress
from pathlib import Path
from typing import Dict, IO, Optional, Tuple

import httpx
import pytest
try:
    import resource
except ImportError:  # pragma: no cover - platform without resource module
    resource = None

REPO_ROOT = Path(__file__).resolve().parents[2]
SUPABASE_WORKDIR = REPO_ROOT / 'supabase'
if not SUPABASE_WORKDIR.exists():
    SUPABASE_WORKDIR = REPO_ROOT
ENV_PATH = REPO_ROOT / '.env.supabase'
LOG_DIR = REPO_ROOT / 'logs'
SUPABASE_CLIENT_LOG_PATH = LOG_DIR / 'supabase-client.log'
ENV_EXPORTS: Dict[str, str] = {}
logger = logging.getLogger(__name__)


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


def _raise_nofile_limit(target: int = 16384) -> None:
    if resource is None:
        return
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    desired = min(hard, max(soft, target))
    if soft < desired:
        resource.setrlimit(resource.RLIMIT_NOFILE, (desired, hard))


CLI_COMMAND = _resolve_cli_command()
FUNCTION_PROC: Optional[Tuple[subprocess.Popen[str], IO[str]]] = None
TRUTHY = {'1', 'true', 'on'}
MANUAL_STACK = os.environ.get('SUPABASE_MANUAL_STACK', '').lower() in TRUTHY
# Provide actionable guidance when CLI automation fails
MANUAL_STACK_HINT = (
    'Either allow pytest to start Supabase automatically (requires Docker + supabase CLI) '
    'or export SUPABASE_MANUAL_STACK=1 after manually running the commands in docs/runbooks/supabase.md '
    '(`npx supabase start`, `curl …/test_reset`, `npx supabase functions serve --env-file .env.supabase --no-verify-jwt`).'
)
USE_SUPABASE_TESTS = os.environ.get('USE_SUPABASE_TESTS', '').lower() in TRUTHY


def _cli_args(*args: str) -> list[str]:
    if CLI_COMMAND is None:
        raise RuntimeError('Supabase CLI is not available.')
    cmd = [*CLI_COMMAND]
    cmd.extend(args)
    return cmd


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
    'corporation_create',
    'corporation_join',
    'corporation_leave',
    'corporation_kick',
    'corporation_regenerate_invite_code',
    'corporation_list',
    'corporation_info',
    'my_corporation',
)


def _edge_url() -> str:
    base = os.environ.get('SUPABASE_URL', 'http://127.0.0.1:54321')
    return os.environ.get('EDGE_FUNCTIONS_URL', f"{base.rstrip('/')}/functions/v1")


def _rest_url() -> str:
    base = os.environ.get('SUPABASE_URL', 'http://127.0.0.1:54321')
    return f"{base.rstrip('/')}/rest/v1"


def _edge_request_headers(include_token: bool = True) -> Dict[str, str]:
    anon = os.environ.get('SUPABASE_ANON_KEY', 'anon-key')
    headers: Dict[str, str] = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {anon}',
        'apikey': anon,
    }
    if not include_token:
        return headers

    token = (
        os.environ.get('EDGE_API_TOKEN')
        or os.environ.get('SUPABASE_API_TOKEN')
        or os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
    )
    if not token:
        raise RuntimeError(
            'EDGE_API_TOKEN (or SUPABASE_API_TOKEN) must be set. '
            'Load .env.supabase before running edge tests.'
        )
    headers['x-api-token'] = token
    return headers


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
        _cli_args(*args),
        capture_output=True,
        text=True,
        check=check,
        cwd=str(SUPABASE_WORKDIR),
    )


def _stack_running() -> bool:
    if CLI_COMMAND is None:
        return False

    result = _run_cli('status', '--output', 'json')
    return result.returncode == 0


def _start_stack() -> None:
    if CLI_COMMAND is None:
        raise RuntimeError('Supabase CLI is not available; cannot start local stack')

    start_cmd = _cli_args('start', '--ignore-health-check')
    try:
        proc = subprocess.Popen(
            start_cmd,
            cwd=str(SUPABASE_WORKDIR),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            preexec_fn=lambda: _raise_nofile_limit(),
        )
    except OSError as exc:  # e.g., Docker missing
        raise RuntimeError(f'Failed to spawn `supabase start`: {exc}. {MANUAL_STACK_HINT}') from exc

    if not proc.stdout:
        proc.terminate()
        raise RuntimeError(f'Failed to capture supabase start output. {MANUAL_STACK_HINT}')

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
            raise RuntimeError(f'Timed out waiting for supabase start to finish. {MANUAL_STACK_HINT}')

    proc.wait(timeout=30)


def _reset_database() -> None:
    if CLI_COMMAND is None or os.environ.get('SUPABASE_SKIP_DB_RESET') == '1':
        return

    result = _run_cli('--yes', 'db', 'reset')
    if result.returncode != 0:
        details = result.stderr or result.stdout or '<no output>'
        raise RuntimeError(
            f'Supabase db reset failed: {details.strip()}\n{MANUAL_STACK_HINT}'
        )


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


def _require_manual_stack_ready() -> None:
    """Ensure a manually started Supabase stack is usable for edge tests."""

    health_payload = _fetch_health_payload('join')
    if health_payload is None:
        raise RuntimeError(
            'Supabase join function is not reachable. '
            'When SUPABASE_MANUAL_STACK=1 you must run:\n'
            '  npx supabase start\n'
            '  npx supabase functions serve --env-file .env.supabase --no-verify-jwt\n'
            '(test_reset will be called automatically before each test)'
        )

    if not health_payload.get('token_present'):
        raise RuntimeError(
            'Edge functions are running without EDGE_API_TOKEN. '
            'Launch `npx supabase functions serve --env-file .env.supabase --no-verify-jwt` '
            'so tests can assert authentication behaviour.'
        )


def _fetch_health_payload(name: str) -> Optional[Dict[str, object]]:
    headers = _edge_request_headers()
    try:
        resp = httpx.post(
            f"{_edge_url().rstrip('/')}/{name}",
            headers=headers,
            json={'healthcheck': True},
            timeout=5.0,
        )
    except httpx.HTTPError:
        return None
    if resp.status_code >= 500:
        return None
    try:
        payload = resp.json()
    except ValueError:
        return None
    return payload if payload.get('status') == 'ok' else None


def _invoke_test_reset() -> None:
    headers = _edge_request_headers()
    try:
        resp = httpx.post(
            f"{_edge_url().rstrip('/')}/test_reset",
            headers=headers,
            json={},
            timeout=120.0,
        )
    except httpx.HTTPError as exc:
        raise RuntimeError('Supabase test_reset RPC failed. Ensure supabase functions serve is running.') from exc

    if resp.status_code == 404:
        raise RuntimeError('test_reset edge function is missing. Did you run functions serve with the repo functions directory?')

    payload = resp.json()
    if not payload.get('success'):
        raise RuntimeError(f"test_reset RPC returned an error: {payload}")


def _verify_reset_data(max_attempts: int = 20, delay_seconds: float = 0.5) -> None:
    """Poll the characters table until reset data is visible via PostgREST."""

    service_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
    if not service_key:
        raise RuntimeError('SUPABASE_SERVICE_ROLE_KEY required to verify reset data visibility')

    headers = {
        'apikey': service_key,
        'Authorization': f'Bearer {service_key}',
    }
    url = f"{_rest_url()}/characters"
    params = {'select': 'character_id', 'limit': 1}

    for attempt in range(1, max_attempts + 1):
        try:
            resp = httpx.get(url, headers=headers, params=params, timeout=5.0)
            if resp.status_code == 200:
                data = resp.json()
                if isinstance(data, list) and data:
                    logger.info('Reset verification succeeded on attempt %s: %s', attempt, data[0])
                    return
                logger.debug('Reset verification attempt %s returned empty payload', attempt)
            else:
                logger.debug(
                    'Reset verification attempt %s returned HTTP %s: %s',
                    attempt,
                    resp.status_code,
                    resp.text[:256],
                )
        except Exception as exc:
            logger.debug('Reset verification attempt %s failed: %s', attempt, exc)

        time.sleep(delay_seconds)

    raise RuntimeError('Test data not visible after reset - connection pool issue?')


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
    cmd = _cli_args('functions', 'serve', '--env-file', str(env_file), '--no-verify-jwt')
    env = os.environ.copy()
    env.setdefault('CHOKIDAR_USEPOLLING', '1')
    env.setdefault('CHOKIDAR_INTERVAL', '1000')
    proc = subprocess.Popen(
        cmd,
        cwd=str(SUPABASE_WORKDIR),
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
        preexec_fn=lambda: _raise_nofile_limit(),
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
        f'Edge functions did not become available. Check logs at {log_path} for diagnostics.\n{MANUAL_STACK_HINT}'
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


@pytest.fixture(scope='session', autouse=True)
def supabase_stack():
    """Ensure a Supabase local stack is up before edge tests run."""

    if CLI_COMMAND is None:
        pytest.skip('Supabase CLI not available; install it or set SUPABASE_CLI_COMMAND="npx supabase@latest"')

    _load_env()
    if not MANUAL_STACK:
        if not _stack_running():
            _start_stack()
        _reset_database()
        _ensure_functions_served(FUNCTIONS_UNDER_TEST)
    else:
        _require_manual_stack_ready()

    try:
        yield
    finally:
        if not MANUAL_STACK:
            _stop_functions_proc()


@pytest.fixture(scope='session', autouse=True)
def test_server():
    """Override the global async test_server fixture for edge tests."""
    yield


if not USE_SUPABASE_TESTS:
    @pytest.fixture(autouse=True)
    def reset_test_state():
        """Edge tests talk directly to Supabase so no FastAPI reset is needed."""
        yield
