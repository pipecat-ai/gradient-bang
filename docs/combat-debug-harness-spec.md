# Combat Debug Harness — Implementation Spec

## Context

Testing and debugging combat today is painful. The only entry point is the production client, which runs through the Pipecat bot + LLMs, renders one player's perspective at a time, and mixes voice narration with raw event signal. Observing what each participant actually receives — or iterating on the combat ruleset itself — requires chaining manual character creation, hopping between browser tabs, and reading raw SQL.

The combat-strategies rework ([combat-strategies-spec.md](combat-strategies-spec.md)) is also coming. We need a fast, observable scratchpad for evolving the engine *before* we commit to a schema and deploy.

The harness is also the **design surface for the orchestration agent** the strategies spec leaves out of scope: an LLM that reads a ship's strategy and submits combat actions on its behalf. Prototyping that agent in-process, with full visibility into prompt, tool calls, and decisions per round, is far easier than iterating on it inside a deployed edge function.

We need a dedicated dev tool that:
- Bypasses the voice bot and all LLMs-on-the-critical-path
- Bypasses Supabase, edge functions, auth, HTTP, and polling
- Runs the **entire combat engine in-process**, in the browser, as plain TypeScript
- Shows, per entity, the exact events that entity's production client *would* have received
- Lets us spawn characters, corp ships, and garrisons into any sector, initiate combat, and drive combat actions as any participant
- Lets us drop an LLM controller onto any ship and watch it reason through combat round-by-round
- Doubles as the **design canvas for the new combat engine and its orchestration agent**: when both are right, the same files port back to production

This tool is **not** a production-client replica. It does not render sector views, combat panels, or ship HUDs. It's a developer instrument for watching the event stream, injecting actions, and iterating on engine + agent mechanics.

---

## What this IS and ISN'T

**IS:**
- A standalone Vite + React app at `client/combat-sim/`
- A self-contained in-browser combat engine — no server, no database, no network for engine operation
- A per-entity event feed: "here's everything the engine emitted to this entity"
- Per-entity action injection: "submit a combat action as this entity" → dispatches directly into the engine
- A prototyping surface for the orchestration agent: LLM-driven controllers can take any ship's turn, with full decision traces visible in the UI
- The **reference implementation** for the combat-strategies rework; designed to port back to production as the shared engine module
- Local-only; no deployment target

**IS NOT:**
- A production-client replica
- A renderer of sector views, combat HUDs, or ship panels from `client/app/src/components/`
- A WebRTC/Pipecat client — there is no bot, no RTVI, no voice
- An HTTP client for edge functions — there is no `GameServerClient`, no polling, no auth
- A long-term parallel implementation — the engine (and its controllers) are written with the explicit goal of replacing `_shared/combat_*.ts` and standing up the production orchestration agent

---

## Design principles

1. **Engine in the browser.** The combat engine runs in-process, synchronously, as plain TypeScript. Actions dispatch directly into it; events come out of it; the UI filters and displays those events. No network layer inside the engine.
2. **Production-shaped events.** Event `type` strings, payload fields, and recipient lists match what production emits today. This is the contract that makes the engine portable back to edge functions without a rewrite.
3. **Pluggable I/O.** The engine talks to the world through two narrow interfaces: a `Storage` adapter (world state) and an `Emitter` adapter (events). The harness wires in-memory implementations; production wires Supabase implementations. The engine itself knows nothing about either.
4. **Deno-compatible TypeScript.** No Node-only APIs, no browser-only APIs, no framework deps in the engine file. It must compile unchanged under both Vite and `deno check`.
5. **Raw events, no transformation.** Show the exact event objects the engine emits, bucketed by recipient. Don't run EventRelay, don't pretty-print by default, don't pre-interpret. This is a debugger, not a game.
6. **Multi-entity first.** Default layout is N entity columns side-by-side so you can see "what Jonboy received" next to "what Corp Probe 1 received" next to "what Garrison X received."
7. **Manual clock.** The harness drives `tick(now)` explicitly (step, auto-run at 1×/4×/16×, or fast-forward to next deadline). Cron is a production concern, not an engine concern.
8. **Decisions live above the engine.** The engine is synchronous and agnostic to *who* decides actions. Human clicks and LLM tool calls both enter through `submitAction`. This keeps engine tests deterministic and lets the same engine drive manual play and agent-driven play without any engine-level branching on controller type.

---

## Architecture

### Location

New Vite + React app at `client/combat-sim/`. Configured as a pnpm workspace sibling of `client/app/`. Builds and runs independently. Imports **only** from `client/combat-sim/src/` — no reach into `client/app/`, no reach into `deployment/`.

### Three halves

```
┌───────────────────────────────────┐   ┌──────────────────────────────┐
│  UI (React)                       │   │  ControllerManager (Phase 5) │
│  ScenarioBuilder | Columns | Log  │   │  per-entity: Manual/LLM/...  │
└───────────────┬───────────────────┘   └──────────────┬───────────────┘
                │                                      │
                │      submitAction / subscribe        │
                └──────────────────┬───────────────────┘
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  CombatEngine (plain TS, no React, no async)                        │
│  ┌─────────────┐  ┌──────────────────┐                              │
│  │ World       │  │ InMemoryEmitter  │                              │
│  │ (Maps)      │  │ (event log)      │                              │
│  └─────────────┘  └──────────────────┘                              │
└─────────────────────────────────────────────────────────────────────┘
```

The engine is a normal TypeScript module the UI and `ControllerManager` both import. UI and `ControllerManager` are peers: both subscribe to the emitter, both can call `engine.submitAction(...)`. The engine never knows whether an action came from a button click or an LLM tool call.

### The engine

Single module to start (`engine.ts`), split into files when it naturally wants to. Public surface:

```ts
class CombatEngine {
  constructor(opts: { emitter: Emitter; now?: () => number; rng?: () => number });

  // World setup — replaces admin edge functions
  resetWorld(): void;
  createCharacter(opts: CreateCharacterOpts): CharacterId;
  createCorpShip(opts: CreateCorpShipOpts): ShipId;
  createCorporation(opts: CreateCorporationOpts): CorpId;
  deployGarrison(opts: DeployGarrisonOpts): GarrisonId;
  teleport(entityId: EntityId, sector: SectorId): void;
  setStrategy(shipId: ShipId, strategy: StrategyInput): void;

  // Combat — replaces combat_initiate / combat_action / combat_tick
  initiateCombat(actorId: EntityId, sector: SectorId): CombatId;
  submitAction(actorId: EntityId, combatId: CombatId, action: CombatAction): ActionResult;
  tick(nowMs: number): void;           // advances any combats whose deadline has passed

  // Observation — powers the UI and DecisionContext builders
  getWorldSnapshot(): World;            // deep-cloned read-only view
  getEventLog(): CombatEvent[];         // chronological, full history
  getEventsForEntity(id: EntityId): CombatEvent[];
}
```

Internally, `CombatEngine` owns a `World` (plain object with `Map`s for characters, ships, garrisons, corporations, sectors, activeCombats, strategies). All state mutation happens inside engine methods; nothing outside the engine touches the world directly.

### The emitter

```ts
interface Emitter {
  emit(event: CombatEvent): void;
  subscribe(listener: (event: CombatEvent) => void): () => void;
}

interface CombatEvent {
  id: string;
  type: string;                       // e.g. "combat.round_waiting"
  payload: unknown;                   // shape matches production
  recipients: EntityId[];             // exact entity IDs scoped to receive this
  actor?: EntityId;
  combat_id?: CombatId;
  sector_id?: SectorId;
  timestamp: number;
}

class InMemoryEmitter implements Emitter {
  private log: CombatEvent[] = [];
  private listeners = new Set<Listener>();
  emit(e) { this.log.push(e); this.listeners.forEach(l => l(e)); }
  subscribe(l) { this.listeners.add(l); return () => this.listeners.delete(l); }
  getLog() { return this.log; }
}
```

Recipient computation lives inside the engine (ported from `_shared/visibility.ts`) so the rules travel with the engine when it moves to production. The harness trusts whatever recipient list the emitter sees and does pure filtering on top.

### Event flow for garrisons

Garrisons are static sector assets that an absent owner (in a different sector) still has skin in the game for. The event-routing + LLM-invocation rules are split across two layers:

1. **Engine `recipients` list** — controls *delivery*. For any combat event involving a garrison, the owner, the owner's corp members, and same-sector observers are all added to `event.recipients`. Uninvolved bystanders (different sector, not in the owner's corp) are NEVER in the set. See `combatRecipients` in `engine.ts` and the per-test lock-in in `agent.test.ts > remote garrison event flow`.
2. **Agent XML filter** (`toAgentEventXml`) — controls *context appending*. Checks both ship participation AND garrison ownership: a viewer whose garrison is in the fight passes `isInvolved` even if they're not a ship participant.
3. **Inference trigger** (`run_llm`, production-only — harness has no voice loop) — controls whether the incoming event *wakes the voice agent*. The harness doesn't enforce this; the production migration must:
   - `combat.round_waiting` / `round_resolved` / `ended` delivered to the absent garrison owner → `run_llm: false` (silent context append). The voice agent must not narrate "round 3 of your garrison's fight" every 30s. RTVI events still fire so the client UI can update the garrison's health bar.
   - `garrison.destroyed` delivered to the owner → `run_llm: true`. The voice agent SHOULD speak — this is the one moment the player needs a verbal heads-up ("Commander, the garrison in sector 42 has fallen.").
   - Same-sector observer receiving combat events about a hostile garrison → standard combat rules apply (`run_llm: true` on their own `combat.round_waiting`, since they're a participant and must act).

**Envelope metadata contract.** Every garrison-related event carries discriminator attributes on the XML envelope so UI / filter code doesn't have to parse the summary body:
- `combat.round_waiting` / `round_resolved` / `ended` that include a garrison: `garrison_id="<combatant_id>"` + `garrison_owner="<character_id>"` appended alongside `combat_id`.
- `garrison.destroyed`: `garrison_id` + `garrison_owner`. The payload additionally includes `internal_garrison_id` (the world-map key, used for row lookup) and `combatant_id` (stable `garrison:<sector>:<owner>` form — same as `garrison_id`).

**Non-involvement is a ROUTING rule, not a filter rule.** If a player is neither in the garrison's sector nor in the owner's corp, they must not be in `event.recipients` in the first place — the filter shouldn't need to defend against them. The "uninvolved player receives nothing" scenario asserts this at the engine layer, not the XML layer.

### World shape

Minimum viable world — combat-adjacent state only. No economy, no ports, no travel costs, no quests:

- `Character { id, name, currentShipId, currentSector, credits, corpId? }`
- `Ship { id, type, ownerCharacterId | ownerCorpId, fighters, shields, cargo, sector }`
- `Corporation { id, name, memberCharacterIds }`
- `Garrison { id, ownerCharacterId, sector, fighters, mode, tollAmount }`
- `CombatStrategy { shipId, template, customPrompt? }`
- `CombatEncounter { id, sector, round, deadline, participants[], actions, state }`

Sectors are implicit (just IDs) — the world doesn't model terrain.

### Controllers (Phase 5+)

A `Controller` decides a ship's combat action. The engine doesn't know controllers exist — they live in the harness, subscribe to engine events, and call `engine.submitAction(...)` with their decision.

```ts
interface Controller {
  decide(ctx: DecisionContext): Promise<CombatAction | null>;
}

interface DecisionContext {
  entityId: EntityId;
  combatId: CombatId;
  round: number;
  self: ParticipantSnapshot;          // own fighters/shields/credits/cargo
  opponents: ParticipantSnapshot[];
  strategy: CombatStrategy | null;
  recentEvents: CombatEvent[];        // last N events this entity received — bucketed
}
```

Three concrete controllers:
- **`ManualController`** — default. No-op on `round_waiting`; the UI action dock submits on behalf of the human.
- **`LLMController { model, apiKey }`** — builds a prompt: ship's `strategy` as system message, `DecisionContext` as user message, engine's combat actions as OpenAI tool schemas. Calls the API, parses the tool call, returns the action.
- **`ScriptedController { actions }`** — deterministic. Returns the next action in the list on each round. Used in the golden event-shape tests so LLM non-determinism never breaks them.

`ControllerManager` owns the `entityId → Controller` registry, subscribes to the engine's emitter, builds the `DecisionContext` from a world snapshot + the entity's bucketed event feed, invokes the controller, and routes the returned action back into the engine. Failures (timeout, invalid tool call, hallucinated target, missing args) surface as rejected `ActionResult`s inline — same path as manual errors. Elegant consequence: the bucketed event feed is already the harness's debug view. Feeding that same feed into the LLM's context is natural — **the debug view IS the agent's memory**.

### UI — three layers

**Layer 1 — Scenario Builder (top toolbar).** Buttons and forms that call engine methods directly:
- **Reset world** → `engine.resetWorld()`
- **Create character** (name, ship type, sector, credits, cargo, fighters, shields) → `engine.createCharacter(...)`
- **Create corporation** → `engine.createCorporation(...)`
- **Add corp ship** → `engine.createCorpShip(...)`
- **Deploy garrison** (owner, sector, fighters, mode, toll) → `engine.deployGarrison(...)`
- **Teleport entity** → `engine.teleport(...)`
- **Set strategy** (template + custom prompt) → `engine.setStrategy(...)`
- **Initiate combat as X** → `engine.initiateCombat(...)`
- **One-click presets**: "2-char combat in sector 42", "char + corp ship vs toll garrison", "3-way free-for-all", "LLM corp ship vs human character" (Phase 5+)
- **Clock controls**: Step, Auto (1×/4×/16×), Jump to next deadline

Created entities automatically appear in the entity roster.

**Layer 2 — Entity Columns (main grid).** Horizontally scrolling grid. Each column binds to one entity and has:
1. **Header**: entity name, type, ship name, current sector, current fighters/shields/credits, **current controller type** (Phase 5+). Pulled from the world snapshot on every tick.
2. **Event feed**: events whose recipient list includes this entity. Chronological, newest on top. Collapsible JSON cards with type badge, timestamp, actor. Filter by event type.
3. **Action dock** (Manual controller only): Attack / Brace / Flee / Pay / Surrender / Surrender-remote / Move / Initiate. Each button calls `engine.submitAction(...)` and renders the returned `ActionResult` inline.
4. **Decision trace** (LLM controller only, Phase 5+): per-round collapsible cards showing full prompt, raw model response, parsed tool call, `ActionResult`, latency, tokens, estimated cost.
5. **Controller picker** (Phase 5+): Manual / LLM (model + strategy dropdown) / Scripted.

**Layer 3 — Global Event Log (bottom drawer).**
- The full `emitter.getLog()`, chronological, unfiltered.
- Columns: timestamp, type, actor, recipients (count, expandable), one-line summary.
- Click to expand full JSON payload + full recipient list.
- Filters: type, entity, sector, `combat_id`.
- Correlation highlighting: clicking an event with a `combat_id` highlights every other row sharing that ID.

### State

App-level Zustand store for UI state only (pinned entity columns, filter settings, clock speed, selected event, per-entity controller assignments). Game state is the engine's `World`; the UI snapshots it on every engine event via `subscribe`.

No persistence across page reloads in MVP — scenarios are meant to be reproducible from presets, not saved. (Optional stretch: serialize `World` + event log + controller assignments to JSON for replay.)

---

## What we build

All new, all under `client/combat-sim/`:

**Scaffold**
- `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`
- `.env.local.example` — OpenAI key placeholder (Phase 5+)

**Engine (Phases 1–4)**
- `src/engine/engine.ts` — the `CombatEngine` class
- `src/engine/types.ts` — `World`, `CombatEvent`, `CombatAction`, all state shapes
- `src/engine/events.ts` — event payload builders (port of `_shared/combat_events.ts`)
- `src/engine/resolution.ts` — round resolution (port of `_shared/combat_engine.ts` + `_shared/combat_resolution.ts`)
- `src/engine/visibility.ts` — recipient scoping (port of `_shared/visibility.ts`)
- `src/engine/emitter.ts` — `Emitter` interface + `InMemoryEmitter`
- `src/engine/__tests__/golden.test.ts` — event-shape golden tests

**Controllers (Phase 5+)**
- `src/controllers/types.ts` — `Controller`, `DecisionContext`, action shapes
- `src/controllers/ControllerManager.ts` — registry + event subscription + dispatch
- `src/controllers/ManualController.ts`
- `src/controllers/LLMController.ts` — OpenAI call, prompt builder, tool-call parser
- `src/controllers/ScriptedController.ts` — deterministic, for golden tests

**UI**
- `src/components/ScenarioBuilder.tsx`
- `src/components/EntityRoster.tsx`
- `src/components/EntityColumn.tsx`
- `src/components/EventLog.tsx`
- `src/components/ClockControls.tsx`
- `src/components/ControllerPicker.tsx` (Phase 5+)
- `src/components/DecisionTrace.tsx` (Phase 5+)
- `src/store/appStore.ts` — Zustand for UI state only

## What we do NOT build

- ❌ `GameServerClient` / HTTP transport
- ❌ Supabase env, auth banner, `admin_override`
- ❌ `events_since` polling
- ❌ `admin_deploy_garrison` or any new edge function
- ❌ Any change to `client/app/`, `deployment/`, or `src/gradientbang/`
- ❌ LLM calls inside the engine — controllers are a harness layer above

---

## Migrating back to production

Once the engine is stable, we swap it into the real edge functions as one atomic PR. The `events` table schema and the edge-function HTTP contract do **not** change — the bot, GameContext, clients, and RTVI consumers see zero behavioural difference. Safety comes from golden tests plus a fixture-diff pass, not runtime feature flags (flagging Deno edge functions is painful and we'd rather not).

### Readiness checklist

Do not open the migration PR until:
- All golden event-shape scenarios pass in the harness
- Engine compiles cleanly under `deno check` (validates principle 4 since day 1)
- No open design questions on mechanics (damage, flee, surrender, strategies)
- Phase 5 LLM controllers have driven at least 2–3 full scenarios end-to-end without manual intervention
- Event captures from 5–10 real production combats (1v1, multi-entity, garrison toll, surrender cascade, corp-ship observer visibility) replay through the harness engine with matching `{type, payload shape, recipient set}`

### Migration principles

1. **Contract preserved.** Request/response shapes, status codes, and `events` rows are byte-compatible before and after. Anything observable to the bot or client stays identical.
2. **One PR, atomic swap.** The engine ships or it doesn't. No parallel-engine feature flag.
3. **Files port as-is.** `client/combat-sim/src/engine/*.ts` → `deployment/supabase/functions/_shared/combat/*.ts` with minimal diff — only type-stripping imports and any Deno-isms added.
4. **Old code parked, not deleted.** Swap PR moves old `_shared/combat_*.ts` into `_shared/_legacy_combat/` (via `git mv`). Delete in a follow-up PR after a week of clean prod combat.

### Steps

**Step 0 — Pre-flight.** Work through the readiness checklist. Write any DB migrations (e.g. `combat_strategies` table, any `sector_contents.combat` JSONB shape changes) and confirm they are forward-compatible with both old and new engines — this unblocks rollback.

**Step 1 — Copy engine into the shared tree.**
- `git mv client/combat-sim/src/engine/{engine,types,events,resolution,visibility,emitter}.ts` → `deployment/supabase/functions/_shared/combat/`
- Add `_shared/combat/supabase_emitter.ts` implementing `Emitter` against `record_event_with_recipients`
- Add `_shared/combat/supabase_storage.ts` if a Storage port was introduced; otherwise keep the existing JSONB-in-`sector_contents` pattern and pass the loaded state into the engine constructor
- `git mv deployment/supabase/functions/_shared/combat_*.ts` → `_shared/_legacy_combat/`
- Run `deno check` on the whole functions directory; fix any imports

**Step 2 — Migrate `combat_tick` first.** Smallest surface (~84 LOC), isolated scope. Replace the body with: load due combats via storage → instantiate engine with `SupabaseEmitter` + state → `engine.tick(now)` → persist. Run Deno integration tests (`bash deployment/supabase/functions/tests/run_tests.sh`).

**Step 3 — Migrate action-ingress functions.** Rewrite each as a thin adapter: parse request → `storage.load` → `engine.<method>` → `storage.save` → return response. In order:
- `combat_initiate`
- `combat_action`
- `combat_set_strategy` (strategies spec)
- `combat_surrender_ship` (strategies spec)
- `combat_leave_fighters`
- `combat_collect_fighters`
- `combat_disband_garrison`
- `combat_set_garrison_mode`

Run both Python and Deno integration suites after each function flips.

**Step 4 — Smoke test against the real client.** Local Supabase + bot + production client: play a 1v1, a multi-entity fight, a toll garrison, and a surrender cascade. Diff emitted events against pre-migration fixtures (see below).

**Step 5 — Deploy.** Staging project first; cross-client scenario with two browsers; then production deploy.

**Step 6 — Delete `_legacy_combat/`.** One release cycle after prod deploy, once there have been no combat-related bug reports for a week, a follow-up PR deletes the parked legacy files.

### Parity verification

Golden tests are the day-to-day safety net. Around the migration we also do a one-time fixture-diff pass against a real DB:

1. **Capture.** Before the swap PR opens, run 5–10 scripted combat scenarios in local Supabase against the *old* engine. Dump each full event sequence as JSON fixtures into `deployment/supabase/functions/tests/fixtures/combat_migration/`.
2. **Replay.** After the swap, re-run the same scenarios. Diff event sequences on `{type, payload shape, recipient set}` — normalize out event IDs, timestamps, and `combat_id` values.
3. Any diff is either a regression or an intentional change; the latter must be called out explicitly in the PR description with rationale.

This pass is heavier than the golden suite (real DB, real edge functions) but only runs around the migration — it doesn't live in day-to-day CI.

### Rollback

If a regression surfaces post-deploy:
- `_shared/_legacy_combat/` still has the old files — `git revert` the swap PR and edge functions redeploy from old code
- DB migrations applied during the swap are **not** reverted; they must have been designed forward-compatible with both engines at Step 0. If they weren't, that's a Step 0 blocker — don't open the PR in the first place.

### Adjacent production fixes (not part of this migration)

Bugs surfaced while building the harness that are unrelated to the engine swap but worth tracking so they don't get lost. Ship each as its own small PR, independent of the migration:

- **`trade` is missing the "cannot act while in combat" guard.** Every other state-mutating edge function (`move`, `dump_cargo`, `ship_sell`, `ship_purchase`, `bank_transfer`, `transfer_credits`) loads `sector_contents.combat`, checks `characterId in combat.participants`, and returns 409 with a "cannot {verb} while in combat" message before mutating state. `trade` has no equivalent check, so a character can complete a trade mid-combat. The fix is a ~5-line copy of the [move/index.ts:306-324](deployment/supabase/functions/move/index.ts:306) pattern. Not a migration blocker, but should be closed out in the same sprint so the harness's combat assumptions match the real server surface.

### New event types introduced by the harness

The engine port also adds event types that don't exist in production today. These are deliberate design additions that should land together with the engine swap — they have payload/routing contracts defined here and locked in by harness tests, so the production add is a near-copy.

- **`garrison.destroyed`** — production today deletes the garrison row silently in [combat_finalization.ts:248-279](deployment/supabase/functions/_shared/combat_finalization.ts:248) (`updateGarrisonState` with `remainingFighters <= 0` → `.delete()` + no emit). Downstream consumers must infer destruction from `fighters_remaining[garrison_id] = 0` inside `combat.round_resolved`. That's fragile: the voice agent has no clean moment to say "commander, the garrison fell", and the client UI has to diff two payloads to notice.
  - **Harness behaviour:** the engine emits `garrison.destroyed` with `garrison_id` / `owner_character_id` / `owner_corp_id` / `owner_name` / `sector` / `mode` / `combat_id` before the row is deleted. Recipients = owner + owner-corp members + sector observers.
  - **Migration work:** add `"garrison.destroyed"` to [event_identity.ts](deployment/supabase/functions/_shared/event_identity.ts)'s type set, emit in `updateGarrisonState` (or `finalizeCombat`) with the same payload shape, and add an `EventConfig` in [event_relay.py](src/gradientbang/pipecat_server/subagents/event_relay.py) with `AppendRule.PARTICIPANT` + `InferenceRule.ON_PARTICIPANT` so the voice agent speaks when a player's own garrison dies.
  - **Test parity:** `agent.test.ts > remote garrison event flow` covers the four routing cases; re-run those scenarios against the ported engine to confirm identical event sequence.

### Controllers migration (Phase 6, separate lift)

After the engine lands and bakes in production, promote `LLMController` from the harness into a real orchestration service. This is out of scope for the engine migration itself — it's a follow-up phase with its own spec.

Candidate architectures (decision deferred):
- A scheduled edge function polling `events` for recent `combat.round_waiting` rows with LLM-controlled participants
- A Supabase Realtime subscription inside a Python worker (colocated with the pipecat bot)
- A peer of `VoiceAgent` / `TaskAgent` in the existing bot pipeline, sharing the bus

Whichever path: `DecisionContext` builder, prompt, tool schemas, and failure handling move verbatim from the harness. The new surface is the event-subscription transport — not the decide logic.

---

## Phased rollout

**Phase 1 — Engine + Log + Scenario Builder (~1 week).** Build the engine with combat_initiate / combat_action / tick / resolution, the `InMemoryEmitter`, Scenario Builder toolbar, clock controls, and the global event log. No per-entity view. End state: you can script a full combat scenario and watch every event emitted.

**Phase 2 — Entity Columns (~3 days).** Add the entity grid with per-entity event feeds using recipient bucketing. No action dock. End state: you can see exactly what each participant receives.

**Phase 3 — Action Docks (~3 days).** Add per-entity action controls. End state: you can drive combat as any entity and observe the full per-entity event fan-out.

**Phase 4 — Strategies surface (~ongoing, tracks strategies spec).** Add the `setStrategy` UI and whatever new events the strategies rework introduces. For this phase, `setStrategy` only stores the record; no evaluation.

**Phase 5 — LLM Controllers (~1 week).** `ControllerManager` + `ManualController` + `LLMController` + `ScriptedController`. Per-entity controller picker and decision trace UI. `VITE_OPENAI_API_KEY` wiring with loud banner if missing. Auto/Step toggle so you can inspect the prompt before the LLM fires. Per-call timeout, concurrency cap, global kill switch, live cost estimate. End state: pit an LLM-controlled corp ship against a human-controlled character and observe the agent's full reasoning per round — prompt in, tool call out, engine result.

---

## Risks

1. **Engine/production divergence during transition.** Once we start evolving the engine in the harness, the production `_shared/combat_*.ts` gets stale. Mitigation: **golden event-shape tests**. A small suite (3–4 canonical scenarios: 1v1 char combat, char + corp ship + garrison, toll-mode garrison, surrender cascade) that asserts the engine's event log matches a checked-in JSON fixture. Run against the harness engine in Vitest; periodically run the same scenarios against a local Supabase and diff. When the engine ports back, these tests go with it.
2. **Recipient scoping drift.** `visibility.ts` has subtle rules (sector occupants, corp members of destroyed ships, dedupe). Port it verbatim and test it. This is the most error-prone part of the move.
3. **Time handling.** Production uses ISO strings and DB timestamps; the engine uses `number` (ms). Keep the engine's time type a plain `number`, do string conversion at adapter boundaries only.
4. **Scope creep.** The harness is easy to turn into a game. Resist. If a feature doesn't help observe or drive combat, it doesn't belong here. Sector rendering, ship HUDs, narration — all out.
5. **Strategies spec churn.** The strategies rework is in flux. Don't build strategy *evaluation* into the engine — evaluation lives in controllers (Phase 5), not the engine. The engine only stores and exposes the strategy record.
6. **LLM non-determinism in tests.** Never run `LLMController` in the golden suite — always `ScriptedController`. Engine tests stay deterministic; controller correctness lives in a separate, API-key-gated suite.
7. **LLM failure surface.** Timeouts, rate limits, empty responses, hallucinated targets, missing required args. `LLMController` must surface each as a rejected `ActionResult` with a clear reason — never crash. Hard per-call timeout (20s default); abort on clock cancel.
8. **API key in the bundle.** `VITE_OPENAI_API_KEY` ends up in the compiled JS. Acceptable because the app is local-only and never deployed, but the README + a loud in-app banner must call this out. `client/combat-sim/.env.local` must be gitignored; verify before first commit.
9. **Cost + rate limits.** Cap max tokens per call; cap concurrent in-flight calls; surface live cost estimate in the UI; global kill switch that reverts all controllers to Manual.

---

## Critical files

**New:**
- `client/combat-sim/package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`
- `client/combat-sim/.env.local.example`
- `client/combat-sim/src/engine/engine.ts`
- `client/combat-sim/src/engine/types.ts`
- `client/combat-sim/src/engine/events.ts`
- `client/combat-sim/src/engine/resolution.ts`
- `client/combat-sim/src/engine/visibility.ts`
- `client/combat-sim/src/engine/emitter.ts`
- `client/combat-sim/src/engine/__tests__/golden.test.ts`
- `client/combat-sim/src/controllers/types.ts`
- `client/combat-sim/src/controllers/ControllerManager.ts`
- `client/combat-sim/src/controllers/ManualController.ts`
- `client/combat-sim/src/controllers/LLMController.ts`
- `client/combat-sim/src/controllers/ScriptedController.ts`
- `client/combat-sim/src/components/ScenarioBuilder.tsx`
- `client/combat-sim/src/components/EntityRoster.tsx`
- `client/combat-sim/src/components/EntityColumn.tsx`
- `client/combat-sim/src/components/EventLog.tsx`
- `client/combat-sim/src/components/ClockControls.tsx`
- `client/combat-sim/src/components/ControllerPicker.tsx`
- `client/combat-sim/src/components/DecisionTrace.tsx`
- `client/combat-sim/src/store/appStore.ts`

**Modified:**
- `pnpm-workspace.yaml` — register `client/combat-sim/`
- Root `package.json` — add `debug:dev` script
- Root `.gitignore` — ensure `client/combat-sim/.env.local` is excluded

**No changes to `client/app/`, `deployment/`, or `src/gradientbang/`.** Zero production risk from this work.

---

## Verification

1. `pnpm --filter debug dev` opens the debug app on a local port. No Supabase, no env (Phases 1–4), no auth.
2. **Reset + seed**: click "Reset world" → event log clears. Click "Create character Alice in sector 42" → event log shows character/ship creation events; Alice appears in the roster.
3. **Multiple entities**: create Bob in sector 42, add a corp ship Probe-1 owned by Alice also in sector 42, deploy a garrison owned by Bob in sector 42 → four entities in the roster.
4. **Pin columns**: drag Alice, Bob, Probe-1, and the garrison to the entity grid → four columns, each with a header reflecting current engine state.
5. **Initiate combat as Alice**: Alice's action dock fires `initiateCombat` → Alice, Bob, Probe-1, and garrison columns all show `combat.round_waiting`; event log shows one emission fanned out to four recipients.
6. **Submit actions from multiple columns**: Alice attacks Bob (commit 20), Bob braces, Probe-1 attacks Bob. Each column shows its own `combat.action_accepted`. Click "Jump to next deadline" → engine ticks; every column shows `combat.round_resolved` with its personalized payload.
7. **Correlation**: click any combat event in the log → all rows with the same `combat_id` highlight.
8. **Rebind column**: retarget Probe-1's column to a different corp ship mid-session → column re-buckets from that point.
9. **Error visibility**: attack yourself → action dock shows the rejected `ActionResult` with reason inline.
10. **Terminal state**: combat ends → all participant columns show `combat.ended` with their personalized final `ship` block; log shows `combat.ended`, `ship.destroyed`, `salvage.created` in order.
11. **Golden tests**: `pnpm --filter debug test` runs the event-shape golden suite. All four canonical scenarios pass.
12. **LLM controller path (Phase 5+)**: set `VITE_OPENAI_API_KEY` in `.env.local`, restart. Create Alice (manual) and a corp ship Probe-1 with an `offensive` strategy. Assign `LLMController(gpt-5-mini)` to Probe-1. Alice initiates combat; jump to next deadline → Probe-1's column shows a decision trace: the full prompt (strategy + context + tool schemas), the OpenAI response, the parsed action (e.g. `attack` target=Alice commit=25), the `ActionResult`, and latency/tokens/cost. Engine advances the round as if the action had been clicked manually.
13. **LLM failure surfacing (Phase 5+)**: break the API key → decision trace shows the error inline and marks Probe-1's action as rejected. Engine falls through to the round's default timeout action, same as a disconnected player.
14. **Scripted controller (Phase 5+)**: the golden test suite drives a scenario via `ScriptedController` and produces byte-identical event logs across repeated runs.
