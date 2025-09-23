## Modified Files

### client/src/GameContext.tsx
- Normalizes every server frame coming from RTVI: reads the new `event`/`payload` envelope, falls back to legacy `gg-action` keys when present, and updates reducers accordingly.
- Adds explicit handlers for `status.init`, `status.update`, `character.moved`, `chat.message`, and other new event ids while keeping backwards compatibility with tool responses. [???]
- Cleans up the switch statement and guards so that undefined payloads no longer crash map or trade reducers.
- Converts `task-output`/`task-complete` listeners to `task_output`/`task_complete`, surfaces upcoming tool execution via a `tool_call` console hook, and respects the new completion payload when marking tasks cancelled.

### game-server/api/{join,move,recharge_warp_power,regenerate_ports,reset_ports,transfer_warp_power}.py
- Replace direct writes to the old `ConnectionManager` with calls to the new `event_dispatcher.emit`, sending typed `status.update`, `character.moved`, `warp.transfer`, `warp.purchase`, and port maintenance events.
- Share a common `build_status_payload` helper so every handler returns the canonical payload (including `name` and `sector_contents`).

### game-server/api/utils.py
- Introduces `build_status_payload`, reuses `sector_contents`, and ensures the returned status payload always contains character name, sector snapshot, and ship details for both RPC replies and push events.

### game-server/core/world.py 
- Removes the legacy `ConnectionManager` class and its startup task; the world bootstrap now just loads data because push delivery is handled by the new dispatcher.

### game-server/server.py ✅
- Rewrites the server as a single FastAPI app hosting `/ws` and `/api/local_map`, wiring in the new event dispatcher, RPC envelope (`frame_type`/`id`/`endpoint`), command handlers (`subscribe`, `identify`), and chat fan-out.
- Adds repo-root path injection so relative imports (e.g., `schemas`) resolve when launched as a script.
- Restores the `local_map` RPC handler so WebSocket clients can fetch localized graphs without the legacy HTTP shim.

### npc/run_npc.py
- Forces WebSocket transport, removes the unused HTTP client option, and reuses the new AsyncGameClient defaults when joining characters.

### npc/status_subscription_demo.py
- Locks to WebSocket transport, consumes `status.update` / `chat.message` event names, and pushes normalized payloads into the local queue.

### pipecat/bot.py
- Emits `status.init`/`status.update` frames instead of the legacy `my_status` action and keeps RTVI compatibility by mirroring the new schema.
- Standardizes the async task lifecycle push by sending `task_complete` events with the schema-compliant payload envelope.

### pipecat/voice_task_manager.py
- Emits schema-compliant `tool_call`, `tool_result`, and `task_output` events (now underscored) including `frame_type`/`event` fields and structured payloads, and trims tool results to summary-only lines before broadcasting.

### tests/test_character_endpoints.py & tests/test_plot_course.py
- Mark the HTTP endpoint tests as skipped with an inline note explaining the WebSocket migration.

### tests/test_server_websocket.py & tests/test_websocket_messaging.py
- Update test helpers to assert against the new frame structure (`frame_type`, `event`, `payload`) and add utility polling so asynchronous events are captured reliably.

### tests/test_utils.py
- Switches AsyncGameClient tests to mock the new `_request` coroutine instead of HTTPX, injects placeholder ship data, and skips optional prompt/tool tests when the modules are unavailable.

### tests/test_utils_integration.py
- Marks the suite as skipped until a WebSocket harness is available and drops the transient HTTPX ASGI transport wiring.

### tui/bot_player_app.py
- Treats `status.init`/`status.update` as status frames so the TUI reflects the new event names.
- Listens for the underscored task lifecycle events and logs tool-call beginnings for future UI wiring.

### utils/api_client.py
- Major refactor to a WebSocket-only client with an internal `_request` RPC helper, `_send_command` for subscribe/identify frames, event dispatch (`status.update` feeding caches), and a custom `RPCError` exception.
- Adds structured caching/diff helpers so tool calls return `LLMResult` objects with concise deltas/summaries for the LLM while preserving the original data for application logic.

### uv.lock
- Bumps `pipecat-ai` to 0.0.85 (the WebRTC build used by the refactored bot flow).

### schemas/server_events.schema.json
- Adds a typed `local_map` event payload (character id, sector, max_hops, node list) and exposes the node definition for downstream generators.

### schemas/generated_events.py & client/src/schemas/serverEvents.ts
- Regenerated to include the `local_map` literal in both Python and TypeScript helper unions.

## New Files & Directories

### game-server/events.py
- Central async dispatcher that knows how to broadcast typed events to connected WebSocket clients.

### schemas/
- `server_events.schema.json`: JSON Schema describing RPC frames and event payloads (including `status.init`) and now enumerating `tool_call`, `tool_result`, `task_output`, and `task_complete` for the Pipecat async task hooks.
- `generated_events.py` & `__init__.py`: cached schema loader plus literal event name definitions generated from the schema.
- `check_trade_response.schema.json`: JSON Schema capturing the `check_trade` RPC result payload.

### client/src/schemas/serverEvents.ts
- TypeScript version of the event schema/constants generated from the same source as the Python module.

### scripts/build_event_types.py
- Code generation script that reads `schemas/server_events.schema.json` and emits the Python/TypeScript helpers.

### docs/server-events-schema.md
- Human-readable documentation rendering the full JSON Schema (now including the formal `status.init` payload) and explaining how to regenerate the artifacts.

### docs/server-events-schema-informal.md
- Client-focused walkthrough covering shared payload shapes, full RPC request/response examples (including `check_trade`), and the expanded event set.
- Documents the new `local_map` RPC/event envelope, including payload fields and sample response.

### client/src/HudMapDebugHarness.tsx & client/hud-map-debug.html
- Minimal harness and standalone HTML entry that preloads mock data into the stores and renders `HudMapVisualization` in isolation for layout debugging.

### client/src/components/HUD/LHS.tsx & App.tsx
- Integrates the Hud map panel above the existing LHS controls, giving it a `clamp(360px,48vh,640px)` height while keeping the Task Output panel constrained to the legacy HUD height. Removes the temporary overlay from `App` and lets the center/RHS columns keep their previous sizing via `var(--height-ui)`.

### client/src/css/index.css
- Restores `--height-ui` to the original 460px value (center + RHS height) and adds a `.hud-map-canvas` helper so Cytoscape fills its container.

### game-server/api/local_map.py & utils/api_client.py & pipecat/bot.py
- Support the new `max_sectors` parameter for `local_map`, prioritising it over `max_hops`, enforcing validation, and threading the limit through the bot’s RTVI relay.

### client/src/components/HudMapVisualization.tsx & client/src/stores/localMap.ts & client/src/HudMapDebugHarness.tsx
- Cache and request local maps by sector counts (default 15 nodes), adapt the local-map store keys to track either `max_sectors` or `max_hops`, switch the render cache key to node+visited signatures, and update the debug harness to reflect the new argument.

### utils/base_llm_agent.py
- Tool message formatting now prefers the compact summaries/deltas emitted by `LLMResult`, drastically shrinking responses sent back to the LLM.

## Removed Files

### game-server/server_websocket.py
- Superseded by the consolidated `game-server/server.py` WebSocket application and the new dispatcher.

## RPC Schema Design Principles

- **Single Envelope:** Every server response or push frame follows `{ frame_type, id?, endpoint?/event?, ok?, result?/error?/payload }`. This keeps clients protocol-agnostic: a single parser can discriminate RPC replies vs. events vs. command acknowledgements.
- **Event Names as Contracts:** Events use dotted snake-case identifiers (`status.update`, `chat.message`, etc.) that double as type keys in both Python `Literal` unions and TypeScript string unions. Changing or adding events requires updating the schema once and regenerating bindings.
- **Change-Driven Status:** Rather than periodic polling, handlers emit `status.update` whenever authoritative state changes (join, move, trade, warp transfer). Clients can subscribe with character filters and rely on strictly-typed payloads.
- **Backwards Compatibility:** The envelope still mirrors the original `gg-action` concept by duplicating the event name in `gg-action` for legacy RTVI consumers, and RPC replies keep `result` semantics so older clients can evolve incrementally.
- **Schema-First Tooling:** Both server and client validate/generate against `server_events.schema.json`, eliminating drift between Python `TypedDict` definitions and TypeScript interfaces.
- **Minimal Transport Coupling:** Commands like `subscribe` and `identify` share the same envelope structure as RPC calls, making it easy to add new control messages without adding bespoke code paths.
