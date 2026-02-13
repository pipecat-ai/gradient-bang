# Client App

Web client for Gradient Bang, built with React + Zustand.

## Architecture

### GameContext (`src/GameContext.tsx`)

The message router. Receives server events via RTVI, parses payloads into typed data, and delegates to the appropriate store method. Should contain:

- Payload parsing and validation (raw server format → typed objects)
- Routing logic (which store method to call for which event)
- No business logic, no console logs, no state computation

### Stores (`src/stores/`)

Zustand store composed of slices via `game.ts`. Each slice owns a domain of state and its mutations.

**Rules for slices:**

- Pure state management: reducers, setters, and orchestration (when to retry, when to re-dispatch)
- No `console.log` / `console.debug` — logging belongs in components that subscribe to state changes
- Compound actions (like `handleMapUIAction`) are fine when they coordinate multiple state updates within the same domain
- Cross-slice access is available via `get()` since slices use `StateCreator<GameStoreState, [], [], SliceType>`
- Closure state (mutable variables outside the returned object) is used for retry counters, flags, etc. that don't need to trigger re-renders

**Slices:**

- `game.ts` — core game state (player, ship, sector, characters, session), `dispatchAction`, fetch promises, store composition and `GameStoreState` type
- `mapSlice.ts` — map data (local/regional sectors, course plots), map UI state (center, zoom, bounds), map actions (fit-to-sectors, auto-recenter, center fallback, `handleMapUIAction`)
- `chatSlice.ts` — chat messages, notifications, bot start params
- `combatSlice.ts` — active combat sessions, combat UI state
- `historySlice.ts` — activity log, movement history, known ports, task history, task events
- `taskSlice.ts` — active tasks, task output, task summaries
- `settingsSlice.ts` — game settings and preferences
- `uiSlice.ts` — broad, app-level UI state (screens, panels, modals, toasts, LLM working indicator). Domain-specific UI properties (e.g. map center, zoom, fit bounds) live in their respective slices so that each domain stays self-contained

### Utils (`src/utils/`)

Pure, stateless helper functions. No store access, no side effects, no logging. Used by slices and components for computation, data normalization, and definition mapping so that business logic stays out of the store and UI layers.
