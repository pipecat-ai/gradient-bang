# CLAUDE.md

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
cd game-server
uv run server.py     # Starts server on http://localhost:8000
```

### Running Tests
```bash
uv run pytest                           # Run all tests
uv run pytest tests/test_utils.py      # Run specific test file
uv run pytest -k test_map_caching      # Run tests matching pattern
```

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

## Architecture

### Client-Server Communication
All game interactions use **AsyncGameClient** (utils/api_client.py). The client:
- Caches map knowledge locally to reduce API calls
- Updates cache automatically on move/status operations  
- Provides client-side logic for finding ports and analyzing the map

### NPC System (OODA Loop)
NPCs operate using an Observe-Orient-Decide-Act loop:
1. **AsyncLLMAgent** (utils/llm_interface.py) manages the conversation with OpenAI
2. **AsyncToolExecutor** (utils/game_tools.py) executes game actions
3. Tools available: plot_course, move, my_status, my_map, find_port, wait_for_time, finished

The NPC receives a natural language task and autonomously executes it using tool calls.

### Map Knowledge Persistence
- Server stores each character's map knowledge in world-data/character-map-knowledge/
- Knowledge accumulates as characters explore (visited sectors, discovered ports, connections)
- Client caches this data and updates it with each move

### WebSocket Firehose
The `/api/firehose` endpoint broadcasts all game events (joins, movements) in real-time. Viewers can connect to visualize game activity.

## Important Conventions

### Commodity Names
Commodities must be exact strings: `"fuel_ore"`, `"organics"`, `"equipment"` (not "ore" or "fuel").

### Async Everything
The entire codebase uses async/await. Never use synchronous GameClient - it has been removed. Always use AsyncGameClient with proper async context managers.

### Sector Movement
Characters can only move one sector at a time to adjacent sectors. The server validates adjacency on each move.

### Tool Definitions
When modifying LLM tools, update descriptions in three places:
1. Pydantic model in game_tools.py
2. OpenAI function definition in get_tool_definitions()
3. Docstrings in AsyncGameClient methods

## Testing Considerations

When testing NPCs or client operations:
1. Start the server first (it loads universe data from world-data/)
2. Character map knowledge persists between sessions
3. Use force_refresh=True on my_map() to bypass cache when needed
4. The universe has 5000 sectors with various port types

## Common Issues

### Port Already in Use
Kill existing server: `lsof -ti:8000 | xargs kill -9`

### NPC Gets Wrong Commodity
Check tool definitions ensure exact commodity names are specified.

### Map Not Updating
Verify _update_map_cache_from_status() is called after moves/status checks.
