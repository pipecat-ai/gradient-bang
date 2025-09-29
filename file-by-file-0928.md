# File-by-file Change Log (2025-09-28)

## client/src/GameContext.tsx
- Wired the global game context into the new chat message store. Incoming `chat.message` events are parsed into a normalized `ChatMessage` structure and pushed to the Zustand store so UI components can render live chat traffic.
- Added logging hooks for the new combat event family (`combat.started`, `combat.round_waiting`, `combat.round_resolved`, `combat.ended`, and `sector.garrison_updated`) to aid debugging.
- Injected the `addChatMessage` action into the context memo so any consumer can push chat updates.

### Suggestions
- Factor the chat payload parsing into a helper (e.g., `deserializeChatPayload`) shared between the context and UI to avoid duplicated defensive checks.
- Gate or downgrade the new combat `console.log` calls; consider using the structured logger with a verbosity flag so production consoles stay clean.

## client/src/components/ConversationPanel.tsx
- Conversation history now pulls from the new chat store and renders server broadcast/direct chat alongside agent/client/system messages.
- Loosened the sender typing to allow arbitrary player names and adjusted text colouring so non-system actors render in a neutral tone.
- Added timestamp formatting helper to display chat timestamps in local 24-hour time.
- Render loop now appends the latest chat entries (with direct-message prefixing) after the existing buffered conversation.

### Suggestions
- Memoise the reversed chat slice with `useMemo` to prevent extra renders when unrelated state updates occur.
- Normalise chat IDs (e.g., `chat-{id}`) in the store so the panel doesn’t need to create composite keys per render.

## client/src/schemas/serverEvents.ts
- Extended the `status.update` schema so each `other_players` entry can optionally include a `ship_type`, matching the richer payload now returned by the server.

### Suggestions
- Regenerate the schema from the authoritative JSON source (if available) to ensure hand edits stay in sync with generated typings.

## client/src/stores/chat.ts
- New Zustand store that records the most recent 200 chat messages, de-duplicates by ID, and exposes `addMessage`/`clear` helpers for the UI.

### Suggestions
- Expose a `replaceAll(messages)` helper so we can hydrate from history without resetting through successive `addMessage` calls.
- Promote `MAX_MESSAGES` to a config constant or setter so automated tests can raise the cap for assertions.

## client/src/utils/console-api.ts
- Normalised file ending by ensuring a trailing newline (no behavioural change).

## docs/server-events-schema-informal.md
- Documented that `status.update` now reports `ship_type` for co-present players.

### Suggestions
- Mention that `ship_type` may be omitted if the knowledge store lacks the value, so integrators expect null/undefined.

## game-server/api/check_trade.py
- Blocks trade previews while a character is engaged in combat by calling the shared `ensure_not_in_combat` helper before running validations.

### Suggestions
- Augment the 409 response with the active combat ID or deadline to improve client-side UX messaging.

## game-server/api/combat_action.py
- HTTP endpoint that submits per-round combat actions. Validates combat membership, enforces fighter requirements, handles flee destination validation, and returns a serialized round outcome when the action resolves combat.

### Suggestions
- Extract attack and flee validation into helper functions to simplify testing and reuse in NPC tooling.
- When a flee succeeds, emit a movement update or relocate the character immediately to prevent the UI from receiving 403s on subsequent turns.

## game-server/api/combat_collect_fighters.py
- Adds API support for pulling fighters off a player-owned garrison back onto the ship, updating knowledge, ship state, and emitting `sector.garrison_updated`.

### Suggestions
- Wrap the garrison mutation in a lock/context to avoid race conditions when multiple requests target the same garrison concurrently.

## game-server/api/combat_initiate.py
- Endpoint for manually entering combat. Rejects requests from fighter-less ships, seeks existing encounters in the sector, or creates new `CombatEncounter` objects and emits `combat.started` plus follow-up scheduling.

### Suggestions
- Include the serialized encounter in the response payload so clients don’t need an immediate follow-up call to `combat_status`.

## game-server/api/combat_leave_fighters.py
- Complements fighter collection by letting players station fighters as a garrison, specifying mode/toll, and emitting sector updates.

### Suggestions
- Verify that the sector parameter matches the character’s current sector to prevent remote deployment exploits.

## game-server/api/combat_set_garrison_mode.py
- Provides an API for changing a garrison’s mode/toll without redeploying fighters, persisting the change and triggering `sector.garrison_updated`.

### Suggestions
- Clamp toll values to non-negative integers before persisting to avoid negative toll states.

## game-server/api/combat_status.py
- Read-only endpoint returning a serialized `CombatEncounter`, including participants, deadlines, and history—used by tooling to inspect active fights.

### Suggestions
- Add optional query params (e.g., `include_history=false`) to reduce payload size for latency-sensitive consumers.

## game-server/api/join.py
- Reworked join flow to hydrate characters with full fighter/shield totals from knowledge, log combats, and auto-trigger combat if hostile garrisons are present on arrival.
- Existing characters now refresh their ship stats from knowledge, and both new/returning joins participate in auto-engage logic via `start_sector_combat`.

### Suggestions
- Return a flag when auto-engaging due to garrisons so clients can notify users about surprise combat.

## game-server/api/move.py
- Refactored parsing/validation helpers (exported `parse_move_destination`/`validate_move_destination`) and blocked movement while in combat via `ensure_not_in_combat`.
- After movement, auto-adds movers to any combat already in the sector, and auto-engages hostile garrisons by calling `start_sector_combat` with detailed logging.

### Suggestions
- Consider debouncing auto-engage when multiple hostile garrisons are present to avoid repeated `start_sector_combat` attempts in the same tick.

## game-server/api/salvage_collect.py
- Implements salvage claiming: marks a container as claimed, transfers cargo/scrap/credits into the player’s knowledge, and removes the container from the manager.

### Suggestions
- Include a loot summary (credits, scrap, cargo) in the response to remove the need for clients to diff knowledge after collection.

## game-server/api/trade.py
- Matches `check_trade` by forbidding trade execution for characters in active combat through `ensure_not_in_combat`.

### Suggestions
- Add the relevant combat ID/deadline to the 409 error so clients can communicate lockouts precisely.

## game-server/api/utils.py
- Introduced `ensure_not_in_combat` plus the shared `COMBAT_ACTION_REQUIRED` message.
- `sector_contents` now includes `ship_type` for other players, friendly flags for garrisons, and live salvage listings, along with expanded port/salvage data.

### Suggestions
- Cache `sector_contents` outputs briefly (e.g., per tick) to reduce repeated port lookups when multiple consumers call the helper.

## game-server/character_knowledge.py
- Added iteration and fighter/shield adjustment helpers (`iter_saved_knowledge`, `set_fighters`, `adjust_fighters`, `set_shields`) used by the combat system.

### Suggestions
- Replace `print` statements inside `iter_saved_knowledge` with structured logging for easier monitoring.

## game-server/combat/__init__.py
- Packages the combat subsystem by exporting `CombatManager`, `GarrisonStore`, and `SalvageManager` for easier imports.

### Suggestions
- Add `__all__` to centralize which symbols are exported, reducing surprises when importing wildcard.

## game-server/combat/engine.py
- Resolves combat rounds: applies attack/brace/flee logic, updates fighters/shields, determines flee success, and produces structured `CombatRoundOutcome` records.

### Suggestions
- Split flee resolution and action collection into helper functions to keep `resolve_round` readable and unit-test friendly.

## game-server/combat/garrisons.py
- Lightweight persistence layer for sector garrisons, supporting deployment, retrieval, updates, and serialization for API payloads.

### Suggestions
- Persist garrison state to disk or knowledge so deployments survive server restarts—currently they live only in memory.

## game-server/combat/manager.py
- Coordinates active encounters by queueing rounds, handling timeouts, emitting `combat.*` events, managing participants, and finalizing combats into history/salvage.

### Suggestions
- Add metrics/logging around round resolution duration and timeout triggers to spot slowdowns or stalled combats quickly.

## game-server/combat/models.py
- Dataclasses/enums describing combat participants, encounters, round actions, outcomes, and persisted garrison state.

### Suggestions
- Provide `.to_dict()` helpers on models used in API responses to reduce inline serialization code elsewhere.

## game-server/combat/salvage.py
- Implements `SalvageManager` and `SalvageContainer`: creates time-limited salvage drops, enforces a 15-minute TTL, and supports listing/claiming/removal.

### Suggestions
- Allow per-container TTL overrides to support special events or missions without changing the default manager setting.

## game-server/combat/utils.py
- Shared utilities for combat (building combatant state from characters/garrisons, serializing encounters/rounds, etc.).

### Suggestions
- Cache character combatant snapshots during serialization to avoid redundant knowledge loads when multiple references to the same participant appear in a payload.

## game-server/core/world.py
- Wires the new combat stack into the world loader (instantiates `CombatManager`, `GarrisonStore`, `SalvageManager`) and hydrates characters with fighters/shields from knowledge.

### Suggestions
- Capture failed combat manager initialization with clearer error messages to simplify diagnosing startup issues.

## game-server/events.py
- Adds schemas and helpers for newly emitted `combat.*`, `sector.garrison_updated`, and salvage-related events.

### Suggestions
- Group combat-related event helpers in a dedicated module so this file remains focused on registry definitions.

## game-server/server.py
- Integrates the combat manager into the websocket/event pipeline, handles active combat resolution, and emits salvage after defeats—including direct credit transfers and escape-pod conversion.

### Suggestions
- Log salvage creation with combat ID/sector to aid future auditing of missing-loot reports.

## game-server/ships.py
- Adds escape-pod metadata and ensures ship stats expose fighter/shield maxima for combat bookkeeping.

### Suggestions
- Audit downstream code for escape-pod compatibility (zero cargo/fighter capacity) to avoid unexpected crashes.

## npc/combat_interactive_tui.py
- Textual-based UI for stepping through combat with websocket logging, manual action prompts, and round summaries.

### Suggestions
- Format large payload logs (truncate or pretty-print) to maintain readability within the TUI.

## npc/combat_logging.py
- Helper utilities for writing combat logs to disk, used by the TUIs for record keeping.

### Suggestions
- Introduce log rotation or a max-file-size policy so long-running sessions don’t exhaust disk space.

## npc/combat_session.py
- Async helper that subscribes to combat/player events, maintains encounter state, and exposes high-level helpers (available actions, waiters) for the TUIs.

### Suggestions
- Add reconnection logic or event replay support for websocket disconnects during combat to prevent stale state.

## npc/combat_strategy.py
- Encapsulates automated combat decision making (when to attack/brace/flee, commit counts) for NPC scripts.

### Suggestions
- Parameterize aggression thresholds so different NPC personalities can reuse the same core strategy.

## npc/combat_utils.py
- Shared utilities for NPC combat tooling (ensure position, payload summarization, etc.).

### Suggestions
- Memoise `ensure_position` calls per tick to avoid redundant status updates when task logic chains multiple combat helpers.

## npc/simple_tui.py
- Combined task/combat Textual interface: can run TaskAgent workflows, display combat rounds, show occupants/ports, manage hotkeys, and auto-cancel tasks when combat starts.

### Suggestions
- Split the class into UI/layout, task-controller, and combat-controller modules to keep the file maintainable and unit-testable.
- Handle successful flee events by auto-switching back to task mode even if no `combat.ended` arrives (defensive guard).

## pipecat/voice_task_manager.py
- Subscribed the voice task manager to chat events and forwards them to RTVI clients; registers the new `send_message` tool and subscribes to personal messages after join.

### Suggestions
- Throttle or batch chat forwarding if the server emits bursts of messages to prevent overwhelming RTVI clients.

## schemas/generated_events.py
- Added combat and garrison events to the generated literals so client code can type-check the expanded event surface.

### Suggestions
- Update downstream switch statements/tests to cover the new event names, ensuring missing handlers are caught early.

## schemas/server_events.schema.json
- Formal schema now enumerates the new `combat.*` and `sector.garrison_updated` events and documents additional payload fields (e.g., `ship_type`).

### Suggestions
- Break out common payload fragments (garrison, salvage, combat round) into `$ref`s to reduce duplication and ease future edits.

## utils/api_client.py
- Major refurbishing: added typed event handler registration/removal, predicate-based `wait_for_event`, and automatic chat subscriptions.
- Support for new combat/salvage endpoints and reworked websocket auto-subscriptions to rely on server filtering.

### Suggestions
- Provide context-manager helpers for scoped event handlers so temporary listeners are removed even if an exception occurs.

## utils/base_llm_agent.py
- Tool registration now accepts optional init kwargs and returns fully-initialized tool objects; log output includes full tool result payloads.

### Suggestions
- Restore optional output truncation or structured logging for tool results to avoid console overflow with large payloads.

## utils/combat_tools.py
- Defines structured OpenAI tool definitions for combat interactions (attack/brace/flee, status queries, etc.) used by TaskAgent and pipecat.

### Suggestions
- Generate the tool schemas from JSON definitions (e.g., using `utils/tool_schemas/combat.json`) to prevent manual drift.

## utils/task_agent.py
- Pulled in the combat toolset (and new salvage collector), expanded tool list to include combat automation, and wired output callbacks for richer logging.

### Suggestions
- Accept a custom tool list override so different NPC profiles can run with limited capabilities when needed.

## utils/tool_schemas/combat.json
- JSON schema describing the combat tool payloads, consumed by the tool registration helpers.

### Suggestions
- Add unit tests that validate tool definitions against this schema to catch accidental mismatches early.

## utils/tools_schema.py
- Added `SalvageCollect` tool and updated existing tools to allow ship-type metadata in status responses.

### Suggestions
- Group related tool definitions (combat, trade, chat) into submodules to keep this file from becoming monolithic.

## uv.lock
- Dependency lockfile updated (most notably to align with `textual>=6.1.0`).

### Suggestions
- Audit transitive dependencies added by the new subsystems and prune unused packages to keep the environment lean.

