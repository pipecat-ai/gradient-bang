# CLAUDE.md

NEVER ADD OR COMMIT ANY FILES TO GIT. USER WILL ADD AND COMMIT TO GIT MANUALLY.

**📋 Note:** For comprehensive analysis of the combat test suite, including detailed test breakdowns, event specifications, and prioritized improvement recommendations, see **[docs/combat_tests_analysis.md](docs/combat_tests_analysis.md)** (1,885 lines covering all 12 combat tests, 16 event types, and 20 strategic improvements).

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Gradient Bang is a TradeWars-inspired space trading game with AI-controlled NPCs. The system consists of:
- A FastAPI game server managing the universe, characters, and game state
- AsyncIO-based client libraries for interacting with the server
- LLM-powered NPCs that can execute natural language tasks
- WebSocket-based real-time event streaming (firehose)
- Terminal-based visualization tools

## Commands

### Development Environment
```bash
# This project uses uv (not pip) for dependency management
uv sync              # Install dependencies
uv run <script>      # Run any Python script
```

### Running the Server
```bash
# Standard method (from project root)
uv run python -m game-server     # Starts server on http://localhost:8000

# Alternative methods
cd game-server && uv run python server.py
cd game-server && uv run python -m .
```

### Running Tests
```bash
# Run all tests
uv run pytest

# Run specific test file
uv run pytest tests/test_utils.py

# Run tests matching pattern
uv run pytest -k test_map_caching

# Run with verbose output
uv run pytest -v

# Run with extra verbose output (shows test names and output)
uv run pytest -vv

# Stop on first failure
uv run pytest -x
```

#### Integration Tests (Combat, Events, etc.)
Integration tests automatically start and stop a test server on port 8002 using pytest fixtures.

**IMPORTANT**: You do NOT need to manually start a test server. The `test_server` fixture in `tests/conftest.py` automatically:
1. Starts the server on port 8002 with `tests/test-world-data` before any tests run
2. Stops the server after all tests complete
3. Is session-scoped and shared across all test files

```bash
# Run all integration tests (server starts automatically)
uv run pytest tests/integration/ -v

# Run combat test suite
uv run pytest tests/test_combat_scenarios_comprehensive.py -v

# Run event system tests
uv run pytest tests/integration/test_event_system.py -v

# Run specific combat test
uv run pytest tests/test_combat_scenarios_comprehensive.py::TestBasicCombatScenarios::test_two_players_combat_attack_actions -xvs

# Run all tests in a specific test class
uv run pytest tests/test_combat_scenarios_comprehensive.py::TestGarrisonModes -v
```

**Combat Test Suite Details:**
- **12 comprehensive tests** covering all combat scenarios
- **Total runtime:** ~3 minutes (189 seconds)
- **Test server:** Automatically started on port 8002 by pytest fixtures
- **Test categories:**
  - `TestBasicCombatScenarios` (3 tests) - 2-player, 3-player, action combinations
  - `TestPlayerDestruction` (2 tests) - Salvage and escape pods
  - `TestSalvageCollection` (1 test) - Auto-brace mechanics and sector updates
  - `TestGarrisonScenarios` (2 tests) - Garrison with/without owner
  - `TestGarrisonModes` (3 tests) - Toll, offensive, defensive modes
  - `TestCombatEndedEvents` (1 test) - Event propagation

**Test Logs:**
All test execution logs are saved to `docs/test_logs/` for debugging and analysis.

**Test Fixtures (tests/conftest.py):**
- `test_server` (session, autouse=True): Starts/stops test server automatically
- `reset_test_state` (function, autouse=True): Resets state after each test
- `check_server_available`: Skips tests if server isn't responding

**Detailed Analysis:**
See `docs/combat_tests_analysis.md` for comprehensive documentation including:
- Step-by-step test flow analysis
- Event specifications with complete payloads
- Identified issues and improvement recommendations
- Performance optimization opportunities

### Running NPCs
```bash
# Requires OPENAI_API_KEY environment variable
uv run npc/run_npc.py <character_id> "<task>"

# Example:
export OPENAI_API_KEY="your-key"
uv run npc/run_npc.py 2b4ff0c2-1234-5678-90ab-1cd2ef345678 "Move to sector 10 and find the nearest port"
```

`<character_id>` must be the immutable UUID stored in the registry, not the display name shown in-game. Use `uv run scripts/character_lookup.py "Display Name"` (and `scripts/character_modify.py` for edits) to manage entries before launching NPCs or TUIs.

### Terminal Viewers
```bash
# Watch real-time events
uv run tools/firehose_viewer.py --server http://localhost:8000

# Track character movement with ASCII map
uv run tools/character_viewer.py --character <character_id>
```

## Recent Architecture Changes (2024)

### Removal of Pydantic Models
The codebase has been refactored to remove all Pydantic models in favor of plain JSON dictionaries. This simplifies the data flow and eliminates transformation layers:
- **Before**: LLM → tools → Pydantic models → API → Pydantic models → server
- **After**: LLM → tools → dict → API → dict → server

This change improves reliability by ensuring the exact JSON from the LLM flows through unchanged.

## Architecture

### Client-Server Communication
All game interactions use **AsyncGameClient** (utils/api_client.py). The client:
- Uses plain JSON dictionaries for all API calls (no Pydantic models)
- Caches map knowledge locally to reduce API calls
- Updates cache automatically on move/status operations  
- Provides client-side logic for finding ports and analyzing the map

**Important**: All API responses are plain dictionaries. Access fields with dict notation (e.g., `status['sector']` not `status.sector`)

### NPC System
NPCs operate using an LLM-driven task execution system:
1. **TaskAgent** (utils/task_agent.py) manages the conversation with OpenAI
2. **Tools** defined in utils/tools_schema.py using pipecat adapters
3. **AsyncGameClient** (utils/api_client.py) executes game actions

Available tools:
- `my_status`: Get current position and ship status
- `my_map`: Get known map data
- `plot_course`: Calculate path between sectors
- `local_map_region`: Get all known sectors around current location for local navigation
- `list_known_ports`: Find all known ports within travel range with optional filtering
- `path_with_region`: Get path to destination plus local context around each path node
- `move`: Move to adjacent sector
- `trade`: Buy/sell commodities at ports
- `recharge_warp_power`: Refuel at sector 0
- `transfer_warp_power`: Give fuel to another player
- `start_task`/`stop_task`: Manage complex multi-step tasks

The NPC receives a natural language task and autonomously executes it using tool calls. JSON flows directly from LLM → tools → AsyncGameClient → server without transformation.

### Map Knowledge Persistence
- Server stores each character's map knowledge in world-data/character-map-knowledge/
- Knowledge accumulates as characters explore (visited sectors, discovered ports, connections)
- Client caches this data and updates it with each move

### WebSocket Firehose
The `/api/firehose` endpoint broadcasts all game events (joins, movements) in real-time. Viewers can connect to visualize game activity.

### API Endpoints
All endpoints accept and return JSON dictionaries:
- `POST /api/join` - Join/rejoin the game
- `POST /api/move` - Move to adjacent sector (params: `character_id`, `to_sector`)
- `POST /api/my_status` - Get current status (params: `character_id`)
- `POST /api/my_map` - Get map knowledge (params: `character_id`)
- `POST /api/plot_course` - Find path (params: `from_sector`, `to_sector`)
- `local_map_region` - Get sectors around location (params: `character_id`, optional `center_sector`, `max_hops`, `max_sectors`)
- `list_known_ports` - Find ports within range (params: `character_id`, optional `from_sector`, `max_hops`, `port_type`, `commodity`, `trade_type`)
- `path_with_region` - Get path with context (params: `character_id`, `to_sector`, optional `region_hops`, `max_sectors`)
- `POST /api/trade` - Execute trade (params: `character_id`, `commodity`, `quantity`, `trade_type`)
- `POST /api/recharge_warp_power` - Buy fuel at sector 0
- `POST /api/transfer_warp_power` - Transfer fuel to another player

## Important Conventions

### Commodity Names
Commodities must be exact strings: `"quantum_foam"`, `"retro_organics"`, `"neuro_symbolics"` (not "ore" or "fuel").

### Async Everything
The entire codebase uses async/await. Never use synchronous GameClient - it has been removed. Always use AsyncGameClient with proper async context managers.

### Sector Movement
Characters can only move one sector at a time to adjacent sectors. The server validates adjacency on each move.

### Tool Definitions
When modifying LLM tools, ensure consistency between:
1. **tools_schema.py**: Tool class definitions with FunctionSchema
2. **AsyncGameClient methods**: Must match parameter names exactly
3. **Server endpoints**: Must accept same JSON structure

**Parameter Naming**:
- `plot_course`: uses `from_sector`, `to_sector` (not `from`/`to`)
- `move`: uses `to_sector` (not `to`)
- `trade`: uses `commodity`, `quantity`, `trade_type`

## Writing Integration Tests

### Test Infrastructure (Automatic)

**IMPORTANT**: Integration tests automatically start/stop a test server on port 8002. Do NOT manually start a server.

**Test Fixtures** (`tests/conftest.py`):
- `test_server` (session, autouse=True): Automatically starts test server before any tests, stops after all tests complete
- `reset_test_state` (function, autouse=True): Resets state after each test (clears characters, combat, events, files)
- `server_url`: Returns `"http://localhost:8002"` for use in tests

**Test Data Isolation**:
- Test server uses `tests/test-world-data/` (10 sectors, seed 12345)
- Production server uses `world-data/` (5000 sectors)
- Test characters are auto-registered from `tests/helpers/character_setup.py`

### Character Registration

**Add test characters to `tests/helpers/character_setup.py`**:
```python
TEST_CHARACTER_IDS = [
    # ... existing characters ...
    "test_my_feature_char1",
    "test_my_feature_char2",
]
```

Then register before tests run:
```python
uv run python -c "from tests.helpers.character_setup import register_all_test_characters; register_all_test_characters()"
```

### Common Test Patterns

**Basic client setup**:
```python
async def test_example(server_url):
    char_id = "test_example_char"
    client = AsyncGameClient(base_url=server_url, character_id=char_id, transport="websocket")

    try:
        await client.join(character_id=char_id)
        # ... test code ...
    finally:
        await client.close()
```

**Get status with event**:
```python
from helpers.test_helpers import get_status

status = await get_status(client, char_id)
sector_id = status["sector"]["id"]
fighters = status["ship"]["fighters"]
```

**Event testing (WebSocket + JSONL verification)**:
```python
from datetime import datetime, timezone
import asyncio

# 1. Setup event collector
events = []
client.on("event.name")(lambda p: events.append({"event": "event.name", "payload": p}))

# 2. Record time range
start_time = datetime.now(timezone.utc)
await asyncio.sleep(0.1)

# 3. Trigger action
await client.some_action(character_id=char_id)
await asyncio.sleep(0.5)  # Wait for event propagation

end_time = datetime.now(timezone.utc)

# 4. Verify WebSocket reception
assert len(events) >= 1, "Should receive event via WebSocket"

# 5. Verify JSONL logging
result = await client._request("event.query", {
    "character_id": char_id,
    "start": start_time.isoformat(),
    "end": end_time.isoformat(),
})
assert result["count"] > 0, "Should find event in JSONL"
```

**Multi-character positioning**:
```python
# Move character to specific sector (assumes adjacency)
await client.move(to_sector=target_sector, character_id=char_id)
await asyncio.sleep(0.5)

# Verify position
status = await get_status(client, char_id)
assert status["sector"]["id"] == target_sector
```

**Create character with custom stats**:
```python
from helpers.combat_helpers import create_test_character_knowledge

create_test_character_knowledge(
    "test_char",
    sector=1,
    fighters=500,
    shields=200,
    credits=10000,
    ship_type="atlas_hauler",  # or "kestrel_courier"
)
```

### Critical API Response Structures

**Status structure** (use these paths, not others):
```python
status["sector"]["id"]              # Current sector
status["ship"]["fighters"]          # Fighter count
status["ship"]["shields"]           # Shield strength
status["ship"]["cargo_holds"]       # Cargo capacity
status["credits"]                   # Credits (NOT status["ship"]["credits"])
```

**Event payload nesting**:
```python
# WebSocket handler receives full event
client.on("event.name")(lambda p: events.append({"event": "event.name", "payload": p}))

# Access nested data
outer_payload = event["payload"]
actual_payload = outer_payload.get("payload", outer_payload)
char_id = actual_payload.get("player", {}).get("character_id")
```

**Correct method names** (commonly confused):
```python
# Garrison methods (NOT garrison_deploy, garrison_collect, garrison_set_mode)
await client.combat_leave_fighters(fighters=100, character_id=char_id)
await client.combat_collect_fighters(character_id=char_id)
await client.combat_set_garrison_mode(mode="defensive", character_id=char_id)

# Combat flee (use to_sector, NOT destination)
await client.combat_action(action="flee", to_sector=2, character_id=char_id)

# Plot course (no from_sector parameter - uses current location)
result = await client.plot_course(to_sector=5, character_id=char_id)
```

### Test World Configuration

**Sectors**: 10 sectors (0-9), deterministic seed 12345

**Ports**:
- Sector 0: No port (special - fuel recharge)
- Sector 1: Port (BBS) - sells neuro_symbolics
- Sector 3: Port (BSS) - sells retro_organics + neuro_symbolics
- Sector 5: Port (BSB) - sells retro_organics
- Sector 9: Port (BBB) - buys all commodities, sells nothing

**Key adjacencies** (for movement tests):
- 0 → [1, 2, 5]
- 1 → [0, 3, 4]
- All characters spawn at sector 0

**Commodities**: quantum_foam, retro_organics, neuro_symbolics (exact strings required)

### Event Privacy Patterns

**Private events** (only sender sees):
- `status.snapshot` - Character's own status
- `trade.executed` - Character's own trades

**Bilateral events** (sender + recipient only):
- `chat.message` (direct) - Private messages

**Public events** (all sector occupants see):
- `character.moved` - Movement into/out of sector
- `port.update` - Port state changes

**Test pattern for event privacy**:
```python
# Setup 3 clients: actor, observer in same sector, outsider elsewhere
actor_events = []
observer_events = []
outsider_events = []

# Register handlers on all clients
actor_client.on("event.name")(lambda p: actor_events.append(p))
observer_client.on("event.name")(lambda p: observer_events.append(p))
outsider_client.on("event.name")(lambda p: outsider_events.append(p))

# Trigger action
await actor_client.some_action()
await asyncio.sleep(1.0)

# Verify privacy
assert len(actor_events) > 0, "Actor should see event"
assert len(observer_events) == 0 or len(observer_events) > 0, "Depends on event type"
assert len(outsider_events) == 0, "Outsider should not see private/sector events"
```

### Running Tests

```bash
# Run all tests (server auto-starts)
uv run pytest

# Run specific integration test
uv run pytest tests/integration/test_event_system.py -v

# Run with output visible
uv run pytest tests/integration/test_event_system.py::TestClass::test_name -xvs

# Skip slow tests
uv run pytest -m "not stress"
```

### Debugging Test Failures

**Common issues**:
1. **"Character is not registered"**: Add character ID to `tests/helpers/character_setup.py` and re-register
2. **Timeout waiting for events**: Increase `await asyncio.sleep()` duration after actions (0.5s → 2.0s)
3. **Empty JSONL query results**: Check that actions emit events with correct `log_context` (especially `sector` field)
4. **Dict access errors**: API responses are plain dicts - use `response["field"]` not `response.field`
5. **WebSocket not receiving**: Ensure client uses `transport="websocket"` and event handlers registered before action

## Common Issues

### Port Already in Use
Kill existing server: `lsof -ti:8000 | xargs kill -9`

### NPC Gets Wrong Commodity
Check tool definitions ensure exact commodity names are specified.

### Map Not Updating
Verify _update_map_cache_from_status() is called after moves/status checks.

### AttributeError: 'dict' object has no attribute
All API responses are dictionaries now. Use `response['field']` instead of `response.field`.

### Missing character_id
Many AsyncGameClient methods now default to the current tracked character. Pass character_id explicitly if needed.
