# Application Topology

Gradient Bang is organized around a game backend, a live Pipecat voice runtime,
and optional task agents. The backend owns game state and rules. The runtime
owns the active voice session and coordinates client messages, game events,
voice tools, and subagents.

## Top-Level Shape

```text
Web Client
  |
  | WebRTC audio/session transport
  | RTVI messages both directions
  v
bot.py / Pipecat runtime
  |
  v
player PipelineWorker
  |
  +-- voice pipeline: transport -> STT -> voice LLM -> TTS -> transport
  |
  +-- Orchestrator
        |
        +-- ClientMessageHandler
        +-- VoiceRuntime tool handlers
        +-- EventRelay
        +-- Task and BYOA lifecycle
        |
        v
      AsyncGameClient
        |
        +-- Supabase Edge Functions
        |     |
        |     v
        |   Database / game state / event log
        |
        +-- session-scoped pubsub event delivery
              |
              v
            EventRelay

Orchestrator <---- bus ----> TaskAgent children
Orchestrator <---- bus ----> external BYOA agents
```

## Layers

### Web Client

- Connects to the bot runtime over WebRTC.
- Sends and receives audio over the WebRTC transport.
- Sends custom RTVI client messages for runtime commands such as text input or
  voice selection.
- Receives RTVI server messages for UI events such as status, map updates,
  task updates, and chat history.

### Bot Runtime

- `bot.py` is the live session entrypoint.
- It builds the Pipecat voice pipeline: transport, STT, voice LLM, TTS,
  aggregators, gates, metrics, and the `player` `PipelineWorker`.
- The `player` worker owns Pipecat lifecycle and bus identity.
- The main voice LLM runs inline inside the `player` pipeline.

### Orchestrator

- `Orchestrator` is a plain Python coordinator attached to the `player` worker.
- It is not a Pipecat worker subclass.
- It owns session bootstrap, voice tool handling, client-message routing,
  EventRelay integration, task lifecycle, BYOA coordination, and shutdown.
- It acts as the host/facade for behavior that needs the `player` worker's bus,
  children, job groups, and task lifecycle.

### Game API And Database

- Supabase Edge Functions expose game actions: join, movement, trading, combat,
  chat, corporation actions, task lifecycle, BYOA configuration, and event
  queries.
- The database is the source of truth for world state, player state, ships,
  corporations, tasks, events, and BYOA configuration.
- Edge Functions mutate database state and emit game events.

### Async Game Client And Event Delivery

- `AsyncGameClient` is the runtime's HTTP client for Edge Functions.
- It also owns game event delivery for the session.
- Event delivery uses session-scoped pubsub queues.
- During startup, event delivery is prepared before bootstrap RPCs. Bootstrap
  request IDs are captured, non-bootstrap catchup events are replayed, and then
  normal event consumption starts.

### Event Relay

- `EventRelay` receives game events from `AsyncGameClient`.
- It decides whether each event should be sent to:
  - the web client over RTVI
  - the voice LLM context
  - task agents over the bus
- It applies routing rules for direct events, local events, task-owned events,
  combat events, corporation events, and ambient events.
- It formats LLM-facing event summaries/XML while preserving raw event payloads
  for client and bus consumers where needed.

### Voice Runtime

- `VoiceRuntime` binds the voice tool schema to Orchestrator handler methods.
- The Orchestrator executes voice tool calls against `AsyncGameClient`.
- Request IDs are tracked so later game events can be correlated with the tool
  call that caused them.
- Deferred frame handling keeps async game-event completions from racing active
  LLM/tool turns.

### Task Agents

- `TaskAgent` workers are spawned as children of the `player` worker.
- They run their own LLM/tool loop for longer-running autonomous tasks.
- They communicate with Orchestrator over bus messages.
- The bus carries task requests, game events, game tool calls, task updates,
  task completion, combat strategy requests, corporation queries, and presence
  messages.

### BYOA Agents

- BYOA lets an external operator host a task agent for a claimed corporation
  ship.
- The backend stores BYOA ownership and wake configuration.
- The Orchestrator detects BYOA ships, wakes the external agent, waits for
  handshake/presence, and routes task traffic over the same bus protocol used
  by in-process task agents.
- BYOA agents broker game calls through the runtime instead of holding trusted
  game credentials directly.

## Responsibility Boundaries

- Edge Functions own game rules and database writes.
- `AsyncGameClient` owns runtime calls into the game API and event subscription.
- `EventRelay` owns game-event routing and LLM/client/bus distribution.
- `Orchestrator` owns session coordination and runtime state.
- `VoiceRuntime` owns voice tool registration.
- `TaskAgent` and BYOA agents own autonomous task execution.
- `bot.py` owns Pipecat component construction and runner setup.
