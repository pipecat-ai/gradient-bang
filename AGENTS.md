# Repository Guidelines

## Project Structure & Module Organization
- `game-server/`: FastAPI backend (`server.py`) and game logic.
- `client/`: React + Vite UI (TypeScript). Run locally via `npm`.
- `tui/`: Textual-based terminal UI used by `player_tui.py`.
- `utils/`: Python clients, agents, prompts, and tool schemas.
- `npc/` and `pipecat/`: Voice/agent runners and examples (`env.example` for config).
- `tools/` and `scripts/`: Admin utilities and data generation (`scripts/universe-bang.py`).
- `tests/`: Pytest suite (async + integration). Generated data lives in `world-data/`.

## Architecture & Conventions
- JSON everywhere: APIs and tools use plain dictionaries (no Pydantic). Access with `resp['field']`.
- Async-only: use `AsyncGameClient` (`utils/api_client.py`); avoid sync clients.
- Tool/endpoint parameters must match exactly:
  - `plot_course`: `from_sector`, `to_sector`
  - `move`: `to_sector`
  - `trade`/`check_trade`: `commodity`, `quantity`, `trade_type`
- Commodity names are strict: `quantum_foam`, `retro_organics`, `neuro_symbolics`.

## Build, Test, and Development Commands
- Python uses `uv` (Python 3.12+). `uv sync` to install; no manual venv.
  - Generate world: `mkdir -p world-data && uv run scripts/universe-bang.py 5000 1234`
  - Run server: `uv run game-server/server.py` (or `cd game-server && uv run server.py`)
  - Run TUI: `export OPENAI_API_KEY=... && uv run player_tui.py JoePlayer`
  - Pipecat bot: `uv run pipecat/bot.py`
  - Tests: `uv run pytest -q`
- Client (from `client/`):
  - Install: `npm install`
  - Dev server: `npm run dev`
  - Build: `npm run build`
  - Lint: `npm run lint`

## Coding Style & Naming Conventions
- Python: PEP 8, 4 spaces, type hints encouraged. `snake_case` for functions/vars, `PascalCase` for classes, module names lowercase. Keep functions small and tested.
- TypeScript/React: Functional components with `PascalCase` (e.g., `WarpBadge.tsx`), hooks prefixed `useX` in `camelCase`. Keep state in context/hooks under `client/src`.
- Formatting: ESLint config lives in `client/`. No Python formatter enforced—match surrounding style and add docstrings for public interfaces.

## Testing Guidelines
- Frameworks: `pytest`, `pytest-asyncio`, `httpx` (ASGI transport for server tests).
- Naming: files `tests/test_*.py`, async tests use `@pytest.mark.asyncio`.
- Examples:
- Unit tests: `tests/test_utils.py`
- Integration tests (FastAPI app): `tests/test_character_endpoints.py`
- Run: `uv run pytest -q`; target specific tests with `-k` / `::TestName`. For integration tests, ensure `world-data/` exists.
- Combat end-to-end suite: start the server with `PORT=8002 uv run game-server/server.py > game-server-debug.log 2>&1` (allow ~5s for startup) and in another shell run `uv run pytest tests/test_combat_scenarios_comprehensive.py -v`. Expect roughly 3.5 minutes because tests wait for real combat round deadlines.

## Commit & Pull Request Guidelines
- Commits: imperative mood, concise scope (e.g., "add TUI task panel"). Group related changes; keep noise low.
- PRs: clear description, linked issues, test plan/commands, screenshots or logs for UI/behavioral changes. Note any config needs (`OPENAI_API_KEY`, `world-data/`).

## Security & Configuration Tips
- Do not commit secrets. Use `pipecat/env.example` as a reference and export `OPENAI_API_KEY` locally.
- World data: generate into `world-data/` (ignored); server expects it at repo root.

## Common Issues
- Port 8000 in use: `lsof -ti:8000 | xargs kill -9`
- Dict attribute errors: API returns dicts; use `resp['field']`, not `resp.field`.
- Wrong commodity names: use exactly `quantum_foam`, `retro_organics`, `neuro_symbolics`.
- Map not updating: call `my_map(force_refresh=True)` after move/status if cache is stale.
- Missing `character_id`: pass explicitly when the client is not tracking a character.
