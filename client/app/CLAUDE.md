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

### Map system

The map renders sectors, lanes, ports, and ships on a canvas. The rendering pipeline has three layers with strict responsibilities:

- **`BigMapPanel`** (`src/components/panels/BigMapPanel.tsx`) — The React render component. Subscribes to store state, dispatches `get-my-map` fetch actions when data is needed, and manages UI overlays (zoom controls, legend, node details popover). Contains no map logic beyond triggering fetches and passing props down.
- **`SectorMap`** (`src/components/SectorMap.tsx`) — A `React.memo` HOC around the canvas element. Stabilizes the render flow by diffing props (topology, config, center, zoom, course plot, ships) via refs and early-exit checks. Decides *when* the controller needs to update, reframe, or re-render, but does no drawing itself. Also handles ResizeObserver, error boundaries, and controller lifecycle.
- **`SectorMapFX`** (`src/fx/map/SectorMapFX.tsx`) — The imperative canvas renderer. Owns all drawing logic: layout computation, camera transforms, animation (pan/zoom), node/lane/port/grid/label rendering, hit-testing for clicks and hovers. Exposes a `SectorMapController` interface consumed by `SectorMap`.

Supporting files:

- **`mapSlice.ts`** — map data (local/regional sectors, course plots), map UI state (center, zoom, bounds), map actions (fit-to-sectors, auto-recenter, center fallback, `handleMapUIAction`)
- **`src/utils/`** — pure helpers for port codes, sector math, etc.

### Utils (`src/utils/`)

Pure, stateless helper functions. No store access, no side effects, no logging. Used by slices and components for computation, data normalization, and definition mapping so that business logic stays out of the store and UI layers.
