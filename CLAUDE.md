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

#### Combat Tests (Integration Tests)
The comprehensive combat test suite requires a test server running on port 8002:

```bash
# Terminal 1: Start test server
export PORT=8002
uv run python -m game-server

# Terminal 2: Run combat tests
uv run pytest tests/test_combat_scenarios_comprehensive.py -v

# Run specific combat test
uv run pytest tests/test_combat_scenarios_comprehensive.py::TestBasicCombatScenarios::test_two_players_combat_attack_actions -xvs

# Run all tests in a specific test class
uv run pytest tests/test_combat_scenarios_comprehensive.py::TestGarrisonModes -v
```

**Test Suite Details:**
- **12 comprehensive tests** covering all combat scenarios
- **Total runtime:** ~3 minutes (189 seconds)
- **Test server:** Must run on port 8002 (separate from dev server on 8000)
- **Test categories:**
  - `TestBasicCombatScenarios` (3 tests) - 2-player, 3-player, action combinations
  - `TestPlayerDestruction` (2 tests) - Salvage and escape pods
  - `TestSalvageCollection` (1 test) - Auto-brace mechanics and sector updates
  - `TestGarrisonScenarios` (2 tests) - Garrison with/without owner
  - `TestGarrisonModes` (3 tests) - Toll, offensive, defensive modes
  - `TestCombatEndedEvents` (1 test) - Event propagation

**Test Logs:**
All test execution logs are saved to `docs/test_logs/` for debugging and analysis.

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
uv run npc/run_npc.py trader "Move to sector 10 and find the nearest port"
```

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

## Testing Considerations

When testing NPCs or client operations:
1. Start the server first (it loads universe data from world-data/)
2. Character map knowledge persists between sessions
3. Use force_refresh=True on my_map() to bypass cache when needed
4. The universe has 5000 sectors with various port types
5. All API responses are dictionaries - use dict access patterns

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
