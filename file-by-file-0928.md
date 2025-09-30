# File-by-file Change Log (2025-09-28)

## client/src/GameContext.tsx
- Wired the global game context into the new chat message store. Incoming `chat.message` events are parsed into a normalized `ChatMessage` structure and pushed to the Zustand store so UI components can render live chat traffic.
- Added logging hooks for the new combat event family (`combat.started`, `combat.round_waiting`, `combat.round_resolved`, `combat.ended`, and `sector.garrison_updated`) to aid debugging.
- Injected the `addChatMessage` action into the context memo so any consumer can push chat updates.

### Suggestions
- Factor the chat payload parsing into a helper (e.g., `deserializeChatPayload`) shared between the context and UI to avoid duplicated defensive checks.
- Gate or downgrade the new combat `console.log` calls; consider using the structured logger with a verbosity flag so production consoles stay clean.

### Additional Analysis
- **Payload parsing duplication**: Lines 335-373 (chat.message parsing) contain extensive defensive type checking that could be centralized into a schema validation utility or deserializer function. This pattern repeats across multiple event types and increases maintenance burden.
- **Type coercion risks**: The fallback logic for message IDs (lines 353-356) coerces various types to strings with a random fallback. This could mask data quality issues; consider strict validation instead.
- **Production logging**: All combat events log to console unconditionally (lines 323-332). Implement a debug mode flag to conditionally enable verbose logging.

## client/src/components/ConversationPanel.tsx
- Conversation history now pulls from the new chat store and renders server broadcast/direct chat alongside agent/client/system messages.
- Loosened the sender typing to allow arbitrary player names and adjusted text colouring so non-system actors render in a neutral tone.
- Added timestamp formatting helper to display chat timestamps in local 24-hour time.
- Render loop now appends the latest chat entries (with direct-message prefixing) after the existing buffered conversation.

### Suggestions
- Memoise the reversed chat slice with `useMemo` to prevent extra renders when unrelated state updates occur.
- Normalise chat IDs (e.g., `chat-{id}`) in the store so the panel doesn’t need to create composite keys per render.

## client/src/schemas/serverEvents.ts
- Updated `CharacterMovedEvent` to accept both full mover payloads and the trimmed observer variant (`name`/`ship_type`/`movement`) so schema validation matches the new server broadcasts.

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
- Accepts the new `pay` action, wiring the toll-payment workflow and reporting whether the payment succeeded via a `pay_processed` flag (with an explanatory message when it fails and the turn becomes a brace).

### Suggestions
- Extract attack and flee validation into helper functions to simplify testing and reuse in NPC tooling.
- When a flee succeeds, emit a movement update or relocate the character immediately to prevent the UI from receiving 403s on subsequent turns.

### Additional Analysis
- **Validation order issue**: Line 63 checks `is_escape_pod` AFTER validating flee destination (line 58-59). If destination validation fails, users get a generic "invalid destination" error instead of the clearer "escape pods cannot flee" message. Reorder checks to provide better error messages.
- **TOCTOU vulnerability**: Lines 24-42 validate encounter state, fighters, etc., but the combat manager could change between validation and submission (line 66). While the manager will catch this, the endpoint should be designed to handle manager rejections gracefully and return specific error codes.
- **No rate limiting**: High-frequency action spam could overwhelm the combat manager. Consider adding per-character rate limits (e.g., max 10 actions per second).

## game-server/api/combat_collect_fighters.py
- Adds API support for pulling fighters off a player-owned garrison back onto the ship, updating knowledge, ship state, and emitting `sector.garrison_updated`.
- Collecting from a toll garrison now cashes out any stored toll balance, returning the credits in a new `credits_collected` field and resetting the garrison’s bank to zero.

### Suggestions
- Wrap the garrison mutation in a lock/context to avoid race conditions when multiple requests target the same garrison concurrently.

## game-server/api/combat_initiate.py
- Endpoint for manually entering combat. Rejects requests from fighter-less ships, seeks existing encounters in the sector, or creates new `CombatEncounter` objects and emits `combat.started` plus follow-up scheduling.

### Suggestions
- Include the serialized encounter in the response payload so clients don’t need an immediate follow-up call to `combat_status`.

## game-server/api/combat_leave_fighters.py
- Complements fighter collection by letting players station fighters as a garrison, specifying mode/toll, and emitting sector updates.
- Rejects deployments into sectors already garrisoned by another owner and preserves any toll bank when owners add additional fighters to their own garrison.

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
- Teleport joins now mirror the movement redaction rules: movers receive the full teleport payload, while sector observers get minimal arrive/depart frames containing only `name`, `ship_type`, and timing info.

### Suggestions
- Return a flag when auto-engaging due to garrisons so clients can notify users about surprise combat.

## game-server/api/move.py
- Splits movement broadcasting into two payloads: the mover still gets full from/to sector data, but observers now see redacted arrive/depart notices carrying only the character name, ship hull, and timestamp.

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

### Additional Analysis
- **RNG seeding weakness**: Line 59 uses `hash((base_seed, round_number))` for deterministic seeding. Python's hash() can produce collisions, especially across restarts (hash randomization). Use a deterministic hash like `(base_seed * 1000000 + round_number) % (2**32)` or a crypto hash.
- **Attack order fairness**: Lines 186-193 sort attackers by `(fighters, turns_per_warp, pid)`. When ties occur, lexicographic `pid` ordering determines precedence, which could systematically favor certain character IDs. Consider using a seeded shuffle or explicit priority field to ensure fairness.
- **Magic numbers lack documentation**: Constants like `MITIGATE_HIT_FACTOR = 0.6` (line 21) and `SHIELD_ABLATION_FACTOR = 0.5` (line 23) have no comments explaining the game balance rationale. Document these or extract to a balance config file with explanations.
- **Flee logic complexity**: Lines 101-131 handle flee resolution with nested conditionals. Extract to `_resolve_flee_attempts(encounter, actions, rng)` for testability.

## game-server/combat/garrisons.py
- Lightweight persistence layer for sector garrisons, supporting deployment, retrieval, updates, and serialization for API payloads.
- Tracks toll credit balances per garrison and rejects deployments into sectors already occupied by another owner to enforce one-garrison-per-sector.

### Suggestions
- Persist garrison state to disk or knowledge so deployments survive server restarts—currently they live only in memory.

### Additional Analysis
- **File persistence exists but may be fragile**: The class does write to `_path` (lines 156-160), so garrisons ARE persisted to disk. However, the atomic write pattern (tmp file + replace) could fail silently if the filesystem doesn't support atomic rename across filesystems. Add error handling and integrity checks.
- **Thread safety in async context**: Uses `threading.RLock()` (line 18) but the rest of the game server is async. While this works, it mixes concurrency paradigms. Consider using `asyncio.Lock()` and making all methods async for consistency.
- **Race condition in deploy**: Lines 43-49 check for other owners, then conditionally deploy. Two concurrent deploys from different owners could both pass the check before either writes. This breaks the one-garrison-per-sector invariant. The RLock helps but doesn't prevent the TOCTOU issue if called from different async tasks.
- **No validation of toll_amount**: The `deploy` and `set_mode` methods accept arbitrary `toll_amount` values. Negative values could break toll logic. Add validation: `toll_amount = max(0, int(toll_amount))`.

## game-server/combat/manager.py
- Coordinates active encounters by queueing rounds, handling timeouts, emitting `combat.*` events, managing participants, and finalizing combats into history/salvage.
- Processes toll payments under the combat lock (via a pluggable callback), records payments in encounter context, and ends a round early with a `toll_satisfied` terminal state when the garrison attacked and was paid while everyone else braced.
- Ensures terminal rounds are re-dispatched through the normal resolution pipeline so fighter/shield losses persist to knowledge before `combat.ended` fires.

### Suggestions
- Add metrics/logging around round resolution duration and timeout triggers to spot slowdowns or stalled combats quickly.

### Additional Analysis
- **Race condition in toll payment**: The `_process_toll_payment` method modifies `encounter.context` without holding the manager's lock for the entire operation. Payment processing happens outside the lock (via callback at line 114), but context modification happens inside submit_action (lines 247-279). If concurrent actions arrive, this could lead to inconsistent toll registry state.
- **Callback execution ordering bug**: Line 559 uses `asyncio.create_task(self._on_combat_ended(...))` while lines 465, 467, 469, 475 use `await`. This means the `combat.ended` event may fire before `combat.round_resolved` finishes processing, breaking client assumptions about event ordering. All callbacks should use consistent async semantics.
- **Memory leak**: The `_completed` dict (line 53) grows unbounded. Combat encounters remain in memory forever after completion. Implement a max-size LRU cache or TTL-based eviction.
- **Dataclass mutation**: Line 404 uses `setattr(outcome, "round_result", round_result)` to modify a frozen dataclass post-creation. Use `replace()` or add the field to the dataclass constructor instead.
- **Lock granularity**: The manager holds `_lock` during outcome computation (line 384), which includes RNG operations and potentially expensive calculations. Consider releasing the lock earlier to improve concurrency.

## game-server/combat/models.py
- Dataclasses/enums describing combat participants, encounters, round actions, outcomes, and persisted garrison state.
- Adds the `PAY` combat action and persists per-garrison toll balances so payments can carry through combat resolution.

### Suggestions
- Provide `.to_dict()` helpers on models used in API responses to reduce inline serialization code elsewhere.

## game-server/combat/salvage.py
- Implements `SalvageManager` and `SalvageContainer`: creates time-limited salvage drops, enforces a 15-minute TTL, and supports listing/claiming/removal.

### Suggestions
- Allow per-container TTL overrides to support special events or missions without changing the default manager setting.

### Additional Analysis
- **No persistence**: Salvage containers exist only in `_by_sector` dict (line 44). Server restart = all unclaimed loot disappears. For a game with potentially valuable loot, this is a significant issue. Consider persisting to Redis or SQLite.
- **Inefficient pruning**: `prune_expired()` (lines 96-103) iterates all sectors and containers on every `list_sector` and `_find_by_id` call. With thousands of sectors and containers, this becomes O(n) overhead on every read. Implement a scheduled background task that prunes periodically (e.g., every 60 seconds) instead.
- **No TTL override implemented**: Line 55 accepts `ttl` parameter but doesn't actually override default_ttl as suggested. The parameter IS used correctly (line 58), so the original suggestion is already implemented.
- **Timezone assumption**: Uses `timezone.utc` consistently (good), but doesn't validate that `expires_at` is actually in the future during creation. A negative TTL would create already-expired containers.

## game-server/combat/utils.py
- Shared utilities for combat (building combatant state from characters/garrisons, serializing encounters/rounds, etc.).

### Suggestions
- Cache character combatant snapshots during serialization to avoid redundant knowledge loads when multiple references to the same participant appear in a payload.

## game-server/core/world.py
- Wires the new combat stack into the world loader (instantiates `CombatManager`, `GarrisonStore`, `SalvageManager`) and hydrates characters with fighters/shields from knowledge.

### Suggestions
- Capture failed combat manager initialization with clearer error messages to simplify diagnosing startup issues.

## game-server/events.py
- Event dispatcher supports an optional `sector_filter`, delegating sector-aware routing to sinks that implement `matches_sectors`.

### Suggestions
- Group combat-related event helpers in a dedicated module so this file remains focused on registry definitions.

## game-server/server.py
- WebSocket connections now cache the latest sector for characters they track via `status.update`, enabling upcoming sector-based filtering through `matches_sectors`.
- Maintains toll-garrison state during combat, automatically submits toll actions each round, handles credit withdrawals via a dedicated payment callback, and redeploys/awards stored toll balances when combats end.

### Suggestions
- Log salvage creation with combat ID/sector to aid future auditing of missing-loot reports.

### Additional Analysis
- **CRITICAL: Toll payment race condition**: `_handle_toll_payment` (lines 176-195) reads credits, subtracts amount, and calls `update_credits` with NO locking mechanism. Multiple concurrent toll payments or trades could corrupt the credit balance. This needs an atomic read-modify-write operation or a database transaction.
- **Garrison auto-submission complexity**: The `_auto_submit_garrisons` function (line 217+) is extremely complex (~100+ lines) and handles toll registry initialization, target selection, mode-based commit calculation, and auto-action submission. This should be extracted to `combat/garrison_automation.py` with dedicated unit tests. Current complexity makes it difficult to reason about correctness.
- **Inconsistent callback patterns**: Some callbacks use `asyncio.create_task()`, others use `await`. Line 193 creates a task for status update emission but line 214+ awaits auto-garrison submission. Document whether these should run concurrently or sequentially.
- **No idempotency in auto-submission**: If `_auto_submit_garrisons` is called multiple times for the same round (e.g., after a participant is added), garrisons could submit duplicate actions. Add round number tracking per garrison to prevent this.

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
- Movement handler now understands redacted observer frames (`movement` + `name`) so occupant tracking stays correct even without sector IDs.

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

## tests/test_websocket_messaging.py
- Websocket helper utilities enforce ≤15 s receive timeouts, retain unmatched frames per connection, and new regression coverage verifies observers only get redacted movement payloads.

### Suggestions
- Extract the timeout-aware helpers into a shared test utility module so other websocket suites can reuse them.

## tests/test_combat_manager.py
- Expanded coverage to exercise toll payment flow, including the new stand-down rule when garrisons are paid mid-round and the failure path that reverts payments to braces.
- Adds a regression test ensuring toll demand stalemates continue into the next round and that terminal rounds still emit the persistence hook.

### Suggestions
- Add integration tests that combine autop-submitted garrison actions with player-initiated pays via the WebSocket pipeline to ensure parity with HTTP tests.

## tests/test_world_persistence.py
- Verifies toll balances are cashed out when owners retrieve fighters and that destroying a toll garrison awards the stored credits to the victor.
- Configures the combat manager with real server callbacks so round resolution updates persisted fighter/shield values, and extends assertions to cover the combat persistence regression.

### Suggestions
- Extend the persistence snapshot to include toll banks so regression tests confirm state survives server restarts.

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

### Additional Analysis
- **Unbounded cache growth**: The `_status_cache` dict (line 92) stores status payloads per character and never evicts old entries. With many characters, this grows unbounded. Implement LRU eviction (e.g., max 1000 entries) or TTL-based cleanup.
- **Deep diff inefficiency**: `_deep_diff` (line 338-362) recursively constructs diff objects that may never be used. The method is called unconditionally but diffs are only needed for summarization. Consider lazy evaluation or only computing diffs when summaries are explicitly requested.
- **Handler removal fragility**: `_event_handler_wrappers` (lines 79-82) maintains a separate mapping from (event, callable) to async wrapper. This could get out of sync if handlers are manipulated through multiple code paths. Consider using WeakKeyDictionary or eliminating the wrapper dict entirely by storing original callables as attributes on the wrapper.
- **No connection recovery**: If the WebSocket disconnects (line 301-308), all pending futures are rejected but there's no automatic reconnection. Long-running clients (NPCs, monitoring tools) will fail permanently on transient network issues. Add exponential backoff reconnection logic.

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

---

# Holistic Analysis and Refactoring Recommendations

## Executive Summary

The 2025-09-28 changes introduce a comprehensive combat system with garrisons, toll mechanics, salvage, and chat integration. The implementation demonstrates strong architectural thinking (separation of engine/manager/models, event-driven design, deterministic combat resolution) but suffers from **critical concurrency bugs**, **unbounded memory growth**, and **inconsistent error handling patterns** that could cause production issues.

## Critical Issues Requiring Immediate Action

### 1. **Toll Payment Race Condition** (SEVERITY: HIGH)
- **Location**: `game-server/server.py:176-195` (`_handle_toll_payment`)
- **Problem**: Credits are read, modified, and written back with no locking. Concurrent payments/trades can corrupt balances.
- **Impact**: Players could lose/gain credits incorrectly; potential exploit for duplicating credits.
- **Fix**: Wrap credit operations in atomic transactions or add per-character credit locks.

### 2. **Combat Event Ordering Bug** (SEVERITY: MEDIUM-HIGH)
- **Location**: `game-server/combat/manager.py:559`
- **Problem**: `combat.ended` callback uses `create_task()` while others use `await`, breaking ordering guarantees.
- **Impact**: Clients receive `combat.ended` before `combat.round_resolved` finishes, causing UI desync and potential data corruption.
- **Fix**: Make all callbacks consistently synchronous (`await`) or explicitly document unordered delivery and design clients defensively.

### 3. **Memory Leaks in Caches** (SEVERITY: MEDIUM)
- **Locations**:
  - `combat/manager.py:53` (_completed dict)
  - `utils/api_client.py:92` (_status_cache)
  - `server.py:88` (_RATE_LIMIT_LAST)
- **Problem**: Unbounded dicts grow forever as encounters complete, characters connect, and messages are sent.
- **Impact**: Server memory usage grows linearly with uptime until OOM.
- **Fix**: Implement LRU eviction (max 10,000 completed combats, 1,000 cached statuses) or periodic cleanup tasks.

### 4. **Garrison Deploy Race Condition** (SEVERITY: MEDIUM)
- **Location**: `game-server/combat/garrisons.py:43-49`
- **Problem**: Check-then-act pattern for other-owner detection isn't atomic across async tasks.
- **Impact**: Two players could deploy to the same sector simultaneously, breaking the one-garrison-per-sector invariant.
- **Fix**: Use database constraints or acquire sector-level lock before checking for existing garrisons.

## Architectural Concerns

### A. **Mixed Concurrency Paradigms**
The codebase mixes `asyncio.Lock()` (manager, client) with `threading.RLock()` (garrisons). While functional, this creates mental overhead and increases deadlock risk.

**Recommendation**: Standardize on `asyncio.Lock()` throughout. Make garrison methods async and await them from server code. This simplifies reasoning about concurrency and enables async-aware debugging tools.

### B. **Inconsistent Error Propagation**
Combat callbacks catch exceptions and log them but don't propagate up (manager.py:490-497). This means fighter/shield updates could silently fail without halting combat.

**Recommendation**: Define explicit error contracts:
- **Retry**: Transient errors (network, disk I/O) should retry with backoff.
- **Halt**: Critical errors (corrupted state, invariant violations) should cancel combat and emit error events.
- **Ignore**: Non-critical errors (analytics failures) should log but continue.

Add a `CombatError` event type for communicating failures to clients.

### C. **Persistence Strategy is Incomplete**
- **Garrisons**: Persist to JSON files (good) but lack integrity checks and atomic reads.
- **Salvage**: Memory-only (bad) - server restart loses all loot.
- **Combat state**: Not persisted - restart during combat leaves players stranded.

**Recommendation**:
1. Add salvage persistence using the same JSON pattern as garrisons.
2. Implement combat checkpoint/recovery so encounters can resume after restarts.
3. Consider migrating to SQLite for ACID guarantees, especially for critical data like credits and fighter counts.

### D. **Configuration Management Gaps**
Magic numbers are scattered throughout:
- Combat engine: `MITIGATE_HIT_FACTOR = 0.6`, `SHIELD_ABLATION_FACTOR = 0.5`
- Salvage: `default_ttl = 900` (15 minutes)
- Manager: `round_timeout = 15.0`
- Garrison commits: Hardcoded percentages in `_garrison_commit_for_mode`

**Recommendation**: Extract to `game-server/config/combat.yaml`:
```yaml
combat:
  round_timeout_seconds: 15
  hit_mitigation_factor: 0.6
  shield_ablation_factor: 0.5
salvage:
  default_ttl_seconds: 900
garrisons:
  offensive_commit_pct: 50
  defensive_commit_pct: 25
  toll_commit_pct: 33
```

Load at startup and pass to components. This enables runtime tuning without code changes.

## Testing Gaps

Based on file-by-file notes, critical paths lack coverage:

1. **Concurrent action submission**: No tests for race conditions when multiple players submit actions simultaneously.
2. **Toll payment edge cases**: Missing tests for insufficient credits, garrison destruction before payment, concurrent payments to same garrison.
3. **Event ordering**: No tests verifying clients receive events in correct sequence.
4. **Persistence recovery**: No tests for loading garrisons after restart or handling corrupted JSON.

**Recommendation**: Add integration tests that:
- Simulate 10 concurrent combatants submitting actions in parallel.
- Test toll payment failure paths (insufficient credits, negative amounts, duplicate payments).
- Verify event ordering using timestamped assertions.
- Corrupt persistence files and verify graceful recovery.

## Performance Optimizations

### 1. **Salvage Pruning is O(n) on Every Read**
`prune_expired()` scans all sectors/containers on every `list_sector()` and `_find_by_id()` call. With 5000 sectors and hundreds of containers, this becomes expensive.

**Solution**: Background task prunes every 60 seconds instead of per-read:
```python
async def _prune_loop(self):
    while True:
        await asyncio.sleep(60)
        self.prune_expired()
```

### 2. **Lock Granularity in Combat Manager**
Manager holds `_lock` during `resolve_round()`, including RNG operations (engine.py:59-273). This serializes all combat resolutions server-wide.

**Solution**: Release lock before calling `resolve_round()` since encounters are independent:
```python
# Copy state needed for resolution
encounter_snapshot = copy.deepcopy(encounter)
actions_snapshot = dict(action_map)

# Release lock for expensive computation
outcome = resolve_round(encounter_snapshot, actions_snapshot)

# Re-acquire lock only to update state
async with self._lock:
    self._apply_outcome(encounter, outcome)
```

### 3. **Deep Diff Computed Unconditionally**
`api_client._deep_diff()` constructs full diff objects even when summaries aren't requested. Most API calls don't need diffs.

**Solution**: Make diff computation lazy:
```python
class LLMResult(dict):
    def __init__(self, data, before=None):
        super().__init__(data)
        self._before = before
        self._delta = None

    @property
    def llm_delta(self):
        if self._delta is None and self._before is not None:
            self._delta = AsyncGameClient._deep_diff(self._before, dict(self))
        return self._delta or {}
```

## API Design Improvements

### Inconsistent Response Envelopes
- `combat_action.py` returns `{"accepted": true, "round": N, "outcome": {...}}`
- `check_trade.py` returns `{"would_buy": N, "price_per_unit": P, ...}`
- Some endpoints return bare dicts, others wrap in `{"result": ...}`

**Recommendation**: Standardize all endpoints:
```python
{
  "success": true,
  "data": { ... },
  "metadata": {
    "timestamp": "2025-09-28T12:00:00Z",
    "request_id": "uuid"
  }
}
```

For errors:
```python
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_FIGHTERS",
    "message": "No fighters available for attack",
    "details": {"required": 1, "available": 0}
  }
}
```

## Observability Gaps

The combat system has extensive logging but no structured metrics. Production issues (stalled combats, timeout spikes, flee success rate imbalance) would be hard to diagnose.

**Recommendation**: Add metrics using Prometheus or similar:
- `combat_rounds_resolved_total` (counter)
- `combat_round_duration_seconds` (histogram)
- `combat_timeouts_total` (counter by reason: player_afk, network_issue)
- `combat_flee_attempts_total` / `combat_flee_success_total` (counters for balance analysis)
- `garrison_deployments_total` (counter by mode: offensive, defensive, toll)
- `toll_payments_total` / `toll_payments_failed_total`

## Refactoring Priorities

### Immediate (This Week)
1. **Fix toll payment atomicity**: Add credit locks.
2. **Fix event ordering**: Make callbacks consistently await.
3. **Add memory eviction**: LRU caches for completed combats and status.
4. **Fix garrison race condition**: Atomic deploy checks.

### Short-term (Next Sprint)
5. **Extract garrison auto-submit**: Move to `combat/garrison_automation.py`.
6. **Add salvage persistence**: Use JSON storage like garrisons.
7. **Standardize API responses**: Create Pydantic models for envelopes.
8. **Add configuration system**: Load combat constants from YAML.

### Medium-term (Next Quarter)
9. **Add metrics instrumentation**: Prometheus endpoints.
10. **Implement combat recovery**: Checkpoint and resume after restarts.
11. **Migrate to SQLite**: Atomic transactions for critical state.
12. **Add comprehensive integration tests**: Concurrent scenarios, failure injection.

### Long-term (Future Roadmap)
13. **Optimize lock granularity**: Per-encounter locks instead of global.
14. **Add rate limiting**: Per-character action throttling.
15. **Implement audit logging**: Track all credit/fighter changes for fraud detection.
16. **Add chaos engineering tests**: Simulate network partitions, slow disks, OOM conditions.

## Conclusion

The combat system is architecturally sound and demonstrates sophisticated game design (deterministic RNG, toll mechanics, salvage timers). However, **production readiness requires fixing the critical concurrency bugs** (toll payment races, event ordering) and **implementing memory management** (cache eviction, bounded collections).

The recommended immediate fixes are low-risk (add locks, await callbacks, LRU caches) and can be implemented in 1-2 days. The medium-term refactoring (configuration, metrics, persistence) will improve maintainability and debuggability significantly.

**Overall Assessment**: Combat system is **70% production-ready**. Critical bugs must be fixed before enabling combat in production. Architecture is strong; execution needs hardening.

---

# New WebSocket Events in This Branch

This branch adds **6 new server-to-client WebSocket events** for the combat system, plus **1 new RPC method**. All events use the standard frame format:

```json
{
  "frame_type": "event",
  "event": "<event_name>",
  "payload": { ... }
}
```

## 1. `combat.started`

Emitted when a new combat encounter begins in a sector. Sent to all participants.

**Example:**
```json
{
  "frame_type": "event",
  "event": "combat.started",
  "payload": {
    "combat_id": "combat_2025-09-28_12-34-56_abc123",
    "sector": 42,
    "round": 1,
    "deadline": "2025-09-28T12:35:11Z",
    "participants": {
      "trader": {
        "combatant_id": "trader",
        "combatant_type": "character",
        "owner_character_id": "trader",
        "name": "trader",
        "ship_type": "merchant_cruiser",
        "fighters": 50,
        "max_fighters": 50,
        "shields": 100,
        "max_shields": 100,
        "turns_per_warp": 2,
        "is_escape_pod": false
      },
      "garrison_pirate": {
        "combatant_id": "garrison_pirate",
        "combatant_type": "garrison",
        "owner_character_id": "pirate",
        "name": "pirate's garrison",
        "fighters": 25,
        "max_fighters": 25,
        "shields": 0,
        "max_shields": 0,
        "turns_per_warp": 0,
        "is_escape_pod": false
      }
    },
    "initiator": "trader",
    "target": null,
    "target_type": null
  }
}
```

**Fields:**
- `combat_id`: Unique identifier for this combat encounter
- `sector`: Sector ID where combat is occurring
- `round`: Current round number (always 1 for started event)
- `deadline`: ISO 8601 timestamp when the round will auto-resolve
- `participants`: Dict mapping combatant_id to combatant state objects
- `initiator`: Character ID who initiated combat (may be null for auto-initiated)
- `target`: Target combatant ID if single-target initiation (usually null)
- `target_type`: Type of target if applicable

## 2. `combat.round_waiting`

Emitted at the start of each round, waiting for all participants to submit actions. Sent to all participants.

**Example:**
```json
{
  "frame_type": "event",
  "event": "combat.round_waiting",
  "payload": {
    "combat_id": "combat_2025-09-28_12-34-56_abc123",
    "sector": 42,
    "round": 2,
    "deadline": "2025-09-28T12:35:26Z",
    "participants": {
      "trader": {
        "combatant_id": "trader",
        "combatant_type": "character",
        "owner_character_id": "trader",
        "name": "trader",
        "ship_type": "merchant_cruiser",
        "fighters": 48,
        "max_fighters": 50,
        "shields": 95,
        "max_shields": 100,
        "turns_per_warp": 2,
        "is_escape_pod": false
      },
      "garrison_pirate": {
        "combatant_id": "garrison_pirate",
        "combatant_type": "garrison",
        "owner_character_id": "pirate",
        "name": "pirate's garrison",
        "fighters": 23,
        "max_fighters": 25,
        "shields": 0,
        "max_shields": 0,
        "turns_per_warp": 0,
        "is_escape_pod": false
      }
    }
  }
}
```

**Fields:** Same as `combat.started` but reflects updated fighter/shield counts after previous round.

## 3. `combat.round_resolved`

Emitted after a round completes with all actions resolved. Sent to all participants plus recently-fled characters.

**Example:**
```json
{
  "frame_type": "event",
  "event": "combat.round_resolved",
  "payload": {
    "combat_id": "combat_2025-09-28_12-34-56_abc123",
    "sector": 42,
    "round": 2,
    "actions": {
      "trader": {
        "action": "attack",
        "commit": 10,
        "target_id": "garrison_pirate",
        "destination_sector": null,
        "timed_out": false
      },
      "garrison_pirate": {
        "action": "attack",
        "commit": 15,
        "target_id": "trader",
        "destination_sector": null,
        "timed_out": false
      }
    },
    "hits": {
      "trader": 6,
      "garrison_pirate": 9
    },
    "offensive_losses": {
      "trader": 4,
      "garrison_pirate": 6
    },
    "defensive_losses": {
      "trader": 9,
      "garrison_pirate": 6
    },
    "shield_loss": {
      "trader": 5,
      "garrison_pirate": 0
    },
    "fighters_remaining": {
      "trader": 35,
      "garrison_pirate": 11
    },
    "shields_remaining": {
      "trader": 90,
      "garrison_pirate": 0
    },
    "flee_results": {
      "trader": false,
      "garrison_pirate": false
    },
    "result": null,
    "end": false,
    "logs": [
      {
        "round": 1,
        "actions": { "...": "..." },
        "hits": { "...": "..." },
        "offensive_losses": { "...": "..." },
        "defensive_losses": { "...": "..." },
        "shield_loss": { "...": "..." },
        "result": null
      },
      {
        "round": 2,
        "actions": { "...": "..." },
        "hits": { "...": "..." },
        "offensive_losses": { "...": "..." },
        "defensive_losses": { "...": "..." },
        "shield_loss": { "...": "..." },
        "result": null
      }
    ]
  }
}
```

**Fields:**
- `combat_id`: Combat encounter ID
- `sector`: Sector where combat occurred
- `round`: Round number that was resolved
- `actions`: Dict of effective actions taken by each combatant (after validation/defaults)
- `hits`: Dict of successful hits landed by each combatant
- `offensive_losses`: Fighters lost when attacking (missed shots)
- `defensive_losses`: Fighters lost defending (enemy hits)
- `shield_loss`: Shield points lost by each combatant
- `fighters_remaining`: Fighter counts after this round
- `shields_remaining`: Shield points after this round
- `flee_results`: Dict indicating which combatants successfully fled (true/false)
- `result`: End state if terminal (e.g., "trader_defeated", "stalemate", "toll_satisfied"), or null if continuing
- `end`: Boolean indicating if combat has ended
- `logs`: Array of all previous rounds' outcomes for history

## 4. `combat.ended`

Emitted when combat concludes (victory, defeat, mutual destruction, flee, toll satisfied). Sent to all participants plus recently-fled characters.

**Example:**
```json
{
  "frame_type": "event",
  "event": "combat.ended",
  "payload": {
    "combat_id": "combat_2025-09-28_12-34-56_abc123",
    "sector": 42,
    "round": 5,
    "actions": {
      "trader": {
        "action": "attack",
        "commit": 20,
        "target_id": "garrison_pirate",
        "destination_sector": null,
        "timed_out": false
      },
      "garrison_pirate": {
        "action": "attack",
        "commit": 8,
        "target_id": "trader",
        "destination_sector": null,
        "timed_out": false
      }
    },
    "hits": {
      "trader": 12,
      "garrison_pirate": 5
    },
    "offensive_losses": {
      "trader": 8,
      "garrison_pirate": 3
    },
    "defensive_losses": {
      "trader": 5,
      "garrison_pirate": 12
    },
    "shield_loss": {
      "trader": 3,
      "garrison_pirate": 0
    },
    "fighters_remaining": {
      "trader": 22,
      "garrison_pirate": 0
    },
    "shields_remaining": {
      "trader": 82,
      "garrison_pirate": 0
    },
    "flee_results": {
      "trader": false,
      "garrison_pirate": false
    },
    "result": "garrison_pirate_defeated",
    "end": true,
    "logs": [
      "... array of all round outcomes ..."
    ],
    "salvage": [
      {
        "salvage_id": "f3a8b92c4d1e",
        "sector": 42,
        "victor_id": "trader",
        "created_at": "2025-09-28T12:36:45Z",
        "expires_at": "2025-09-28T12:51:45Z",
        "cargo": {
          "fuel_ore": 0,
          "organics": 0,
          "equipment": 0
        },
        "scrap": 8,
        "credits": 150,
        "claimed": false,
        "claimed_by": null,
        "metadata": {
          "defeated_garrison_owner": "pirate"
        }
      }
    ]
  }
}
```

**Fields:** Same as `combat.round_resolved`, plus:
- `result`: Terminal state describing combat outcome (e.g., "trader_defeated", "garrison_pirate_defeated", "mutual_defeat", "stalemate", "toll_satisfied", or "{character_id}_fled")
- `end`: Always true
- `salvage`: Optional array of salvage containers created from defeated combatants

## 5. `sector.garrison_updated`

Emitted when a garrison is deployed, collected, or has its mode changed. Sent only to the garrison owner.

**Example (deployment):**
```json
{
  "frame_type": "event",
  "event": "sector.garrison_updated",
  "payload": {
    "sector": 42,
    "garrisons": [
      {
        "owner_id": "trader",
        "fighters": 25,
        "mode": "offensive",
        "toll_amount": 0,
        "toll_balance": 0,
        "deployed_at": "2025-09-28T12:30:00Z"
      }
    ]
  }
}
```

**Example (collection with toll payout):**
```json
{
  "frame_type": "event",
  "event": "sector.garrison_updated",
  "payload": {
    "sector": 42,
    "garrisons": []
  }
}
```

**Fields:**
- `sector`: Sector ID
- `garrisons`: Array of garrison states in this sector (empty if all collected)

**Garrison object fields:**
- `owner_id`: Character ID who owns this garrison
- `fighters`: Number of fighters stationed
- `mode`: Garrison mode ("offensive", "defensive", or "toll")
- `toll_amount`: Credits demanded per toll payment (only relevant for toll mode)
- `toll_balance`: Accumulated toll credits (paid but not yet collected)
- `deployed_at`: ISO 8601 timestamp when garrison was first deployed

## 6. `chat.message`

Emitted when a player sends a broadcast or direct message. Broadcast messages sent to all connected characters; direct messages sent only to sender and recipient.

**Example (broadcast):**
```json
{
  "frame_type": "event",
  "event": "chat.message",
  "payload": {
    "id": "msg_1727530123456_abc",
    "timestamp": "2025-09-28T12:35:23Z",
    "type": "broadcast",
    "from_name": "trader",
    "content": "Looking for a trading partner in sector 100!",
    "to_name": null
  }
}
```

**Example (direct message):**
```json
{
  "frame_type": "event",
  "event": "chat.message",
  "payload": {
    "id": "msg_1727530234567_def",
    "timestamp": "2025-09-28T12:37:14Z",
    "type": "direct",
    "from_name": "trader",
    "to_name": "pirate",
    "content": "Meet me at sector 42 for a trade"
  }
}
```

**Fields:**
- `id`: Unique message ID
- `timestamp`: ISO 8601 timestamp when message was sent
- `type`: Message type ("broadcast" or "direct")
- `from_name`: Sender's character name
- `content`: Message text
- `to_name`: Recipient character name (only for direct messages, null for broadcast)

---

# Additional Design Clarifications

## Race Conditions in Single-Threaded Python

You're correct that Python's GIL provides some protection, but **asyncio introduces concurrency** even in single-threaded code. The critical race conditions identified are:

### Why They're Real Problems:

1. **Toll Payment (server.py:176-195):**
```python
credits = world.knowledge_manager.get_credits(payer_id)  # ← await point 1
# Another coroutine could run here during any I/O
world.knowledge_manager.update_credits(payer_id, credits - amount)  # ← await point 2
```
Between these two calls, another coroutine handling a different combat action or trade could modify the same character's credits. Async I/O operations yield control, allowing interleaving.

2. **Garrison Deploy (garrisons.py:43-49):**
```python
other_owner = next((g for g in garrisons if g.owner_id != owner_id), None)
if other_owner:  # ← Check
    raise ValueError(...)
# Another async task could deploy here
garrisons.append(garrison)  # ← Act
```

The `threading.RLock` protects *this* code path, but if called from async context without proper coordination, multiple async tasks can interleave between check and act.

### Solutions:
- **Async locks** around multi-step operations (get-modify-set sequences)
- **Optimistic locking** with version numbers
- **Database transactions** when you migrate to Supabase (which will provide ACID guarantees)

For now, wrapping credit operations in an async lock would suffice:
```python
_credit_locks: Dict[str, asyncio.Lock] = {}

async def _handle_toll_payment(payer_id: str, amount: int) -> bool:
    lock = _credit_locks.setdefault(payer_id, asyncio.Lock())
    async with lock:
        credits = world.knowledge_manager.get_credits(payer_id)
        if credits < amount:
            return False
        world.knowledge_manager.update_credits(payer_id, credits - amount)
        return True
```

---

## Game Action Log Format

A unified action log would serve multiple purposes:
1. **Audit trail** for debugging/fraud detection
2. **Event sourcing** for state reconstruction
3. **Message history** (replacing separate message files)
4. **Analytics** for game balance

### Recommended Format: JSONL with Structured Events

Use **newline-delimited JSON (JSONL)** in a single append-only file per day:

#### File Structure:
```
world-data/
  action-log/
    2025-09-28.jsonl
    2025-09-29.jsonl
```

#### Log Entry Schema:
```json
{
  "seq": 12345,
  "timestamp": "2025-09-28T12:34:56.789123Z",
  "event_type": "combat.action_submitted",
  "actor_id": "trader",
  "session_id": "ws_abc123",
  "data": {
    "combat_id": "combat_2025-09-28_12-34-56_abc123",
    "action": "attack",
    "commit": 10,
    "target_id": "garrison_pirate"
  },
  "result": "success",
  "metadata": {
    "ip_address": "127.0.0.1",
    "client_version": "0.2.0"
  }
}
```

**Key fields:**
- `seq`: Monotonically increasing sequence number (global counter)
- `timestamp`: High-precision UTC timestamp
- `event_type`: Action/event type (namespaced: "combat.*", "trade.*", "chat.*", "movement.*")
- `actor_id`: Character performing action (null for system events)
- `session_id`: WebSocket connection ID for correlation
- `data`: Event-specific payload
- `result`: Outcome ("success", "failure", "rejected")
- `metadata`: Contextual info (IP, client version, etc.)

### Example Log Entries:

**Combat action:**
```json
{"seq":1001,"timestamp":"2025-09-28T12:34:56.123Z","event_type":"combat.action_submitted","actor_id":"trader","session_id":"ws_abc","data":{"combat_id":"combat_123","action":"attack","commit":10,"target_id":"garrison_pirate"},"result":"success","metadata":{}}
```

**Chat message:**
```json
{"seq":1002,"timestamp":"2025-09-28T12:35:10.456Z","event_type":"chat.message_sent","actor_id":"trader","session_id":"ws_abc","data":{"type":"broadcast","content":"Hello everyone!","message_id":"msg_1002"},"result":"success","metadata":{}}
```

**Trade:**
```json
{"seq":1003,"timestamp":"2025-09-28T12:36:22.789Z","event_type":"trade.executed","actor_id":"trader","session_id":"ws_abc","data":{"commodity":"fuel_ore","quantity":100,"trade_type":"buy","port_id":"port_sector_42","total_price":5000},"result":"success","metadata":{}}
```

**Toll payment:**
```json
{"seq":1004,"timestamp":"2025-09-28T12:37:05.012Z","event_type":"combat.toll_paid","actor_id":"trader","session_id":"ws_abc","data":{"combat_id":"combat_123","amount":500,"garrison_owner":"pirate"},"result":"success","metadata":{}}
```

### Implementation Strategy:

1. **Create ActionLogger class:**
```python
# game-server/action_log.py
import json
from pathlib import Path
from datetime import datetime, timezone
from typing import Any, Dict, Optional
import asyncio

class ActionLogger:
    def __init__(self, log_dir: Path):
        self.log_dir = log_dir
        self.log_dir.mkdir(exist_ok=True)
        self._seq_counter = 0
        self._lock = asyncio.Lock()

    async def log(
        self,
        event_type: str,
        actor_id: Optional[str],
        data: Dict[str, Any],
        *,
        result: str = "success",
        session_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> int:
        async with self._lock:
            self._seq_counter += 1
            entry = {
                "seq": self._seq_counter,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "event_type": event_type,
                "actor_id": actor_id,
                "session_id": session_id,
                "data": data,
                "result": result,
                "metadata": metadata or {},
            }

            # Daily rotation
            today = datetime.now(timezone.utc).date()
            log_file = self.log_dir / f"{today}.jsonl"

            # Append atomically
            with log_file.open("a", encoding="utf-8") as f:
                json.dump(entry, f, separators=(",", ":"))
                f.write("\n")

            return self._seq_counter
```

2. **Integrate into server.py:**
```python
from action_log import ActionLogger

action_log = ActionLogger(get_world_data_path() / "action-log")

# In combat action handler:
await action_log.log(
    "combat.action_submitted",
    character_id,
    {
        "combat_id": combat_id,
        "action": action.value,
        "commit": commit,
        "target_id": target_id,
    },
    session_id=websocket_connection_id,
)
```

3. **Use for message history:**
Replace `MessageStore` with queries against action log:
```python
async def get_messages_since(seq: int, character_id: Optional[str] = None) -> List[Dict]:
    # Read JSONL from seq onwards, filter by character_id for direct messages
    messages = []
    for line in read_jsonl_from_seq(seq):
        if line["event_type"] == "chat.message_sent":
            if character_id and line["data"].get("type") == "direct":
                if line["actor_id"] == character_id or line["data"].get("to_name") == character_id:
                    messages.append(line)
            elif line["data"].get("type") == "broadcast":
                messages.append(line)
    return messages
```

### Transition to Supabase:

The JSONL format maps naturally to a Supabase (PostgreSQL) table:

```sql
CREATE TABLE game_action_log (
    seq BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event_type TEXT NOT NULL,
    actor_id TEXT,
    session_id TEXT,
    data JSONB NOT NULL,
    result TEXT NOT NULL DEFAULT 'success',
    metadata JSONB DEFAULT '{}'::jsonb,

    -- Indexes for common queries
    INDEX idx_timestamp ON game_action_log(timestamp),
    INDEX idx_event_type ON game_action_log(event_type),
    INDEX idx_actor_id ON game_action_log(actor_id)
);

-- Enable row-level security
ALTER TABLE game_action_log ENABLE ROW LEVEL SECURITY;
```

**Migration path:**
1. Keep logging to JSONL initially
2. Add a background worker that tails JSONL and inserts to Supabase
3. Once stable, log directly to Supabase (use Supabase real-time for event distribution)
4. Archive old JSONL files to object storage (S3/Backblaze)

### Benefits:
- **Single source of truth** for all state changes
- **Replayable** for debugging (reconstruct any point in time)
- **Queryable** for analytics (SQLite or Supabase queries)
- **Audit-compliant** (immutable append-only log)
- **Efficient** (sequential writes, no seeking)
- **Future-proof** (easily migrate to Supabase table)
