# Subagents

Voice bot architecture for Gradient Bang.

## Separation of concerns

```
game_client → EventRelay (routing rules)
                ├── RTVI push (client UI)
                ├── VoiceAgent LLM context (queue_frame_after_tools)
                └── VoiceAgent.broadcast_game_event → BusGameEventMessage → bus
                                                       └── TaskAgent.on_bus_message (filter by task_id/character_id)
```

- **MainAgent**: Owns transport pipeline (STT/TTS). Bridges audio to VoiceAgent via bus.
- **VoiceAgent**: Conversational agent. Spawns TaskAgent children per task. Broadcasts game events to bus. Receives task progress/completion via bus protocol. No task tracking dict; queries framework `_task_groups` + `children` for active task state.
- **TaskAgent**: Self-contained autonomous agent. Receives task via bus protocol, game events via bus, reports progress via bus. Calls game server API (move, trade, etc.) via game_client. Has no RTVI access; client updates flow through VoiceAgent. Created fresh per task, ended on completion.
- **EventRelay**: Single game event subscriber. Declarative routing engine. Feeds VoiceAgent. Does NOT manage tasks or forward events to TaskAgents directly.
- **Bus**: Central distribution layer. Carries task protocol (request/response/update/cancel), game events (`BusGameEventMessage`), and steering instructions (`BusSteerTaskMessage`).

## Patterns

- **No task tracking dict** on VoiceAgent. Active tasks come from `self._task_groups` (framework). Child agent metadata comes from `self.children`.
- **Events flow through bus**, not direct game_client subscriptions on TaskAgents.
- **Every task gets a fresh agent**, ended on completion via `BusEndAgentMessage`. No zombie agents.
- **`add_agent` → `on_agent_ready` → `request_task`**: Task requests are deferred until the child's pipeline is built.
- **Custom bus messages** extend `BusMessage` for domain needs: `BusGameEventMessage` (game event distribution), `BusSteerTaskMessage` (mid-task instructions).

## Files

### MainAgent (inline in bot.py)

`BaseAgent()`, defined as an inner class in `run_bot()`. Captures pipeline processors from the enclosing scope. Owns the transport pipeline with `BusBridgeProcessor`. Activates VoiceAgent on ready.

### voice_agent.py

`LLMAgent(bridged=())`. The core agent.

- **16 tools** from VOICE_TOOLS (shared schemas via `register_function` in `create_llm()`)
- **Task spawning**: creates TaskAgent children via `add_agent()`, dispatches work via `request_task()` in `on_agent_ready()`
- **Game event broadcast**: `broadcast_game_event()` sends `BusGameEventMessage` to bus for all TaskAgent children
- **Task lifecycle via bus**: `on_task_update` receives progress, `on_task_response` handles completion/cleanup
- **Framework queries**: `is_our_task()` checks `_task_groups`, `_find_task_agent_by_prefix()` searches children
- **TaskStateProvider protocol**: EventRelay calls `is_our_task`, `is_recent_request_id`, `broadcast_game_event`, `tool_call_active`, `queue_frame_after_tools`

### task_agent.py

`LLMAgent()`. Autonomous task execution.

- **31 tools** from TASK_TOOLS (shared schemas, catch-all handler via `register_function(None, ...)`)
- **Bus-based events**: receives `BusGameEventMessage` in `on_bus_message`, filters by task_id/character_id. No game_client event subscriptions.
- **Inference engine**: async tool completion pattern, event batching, watchdogs, no-tool nudging, error limits
- **Bus protocol**: `on_task_request` starts work, `send_task_update` reports progress, `send_task_response` completes
- **Steering**: handles `BusSteerTaskMessage` for mid-task instruction changes

### bus_messages.py

Custom bus messages extending `BusMessage`:
- `BusGameEventMessage(event)` — broadcasts game events to bus for TaskAgents
- `BusSteerTaskMessage(task_id, text)` — VoiceAgent→TaskAgent mid-task instruction

### event_relay.py

Plain service class (not a BaseAgent). Declarative `EVENT_CONFIGS` registry controls per-event routing.

Minimal task awareness via `TaskStateProvider` protocol:
- `broadcast_game_event(event)` — distribute events to bus
- `is_our_task(task_id)` — check if event belongs to our task
- `is_recent_request_id` — request ID cache
- `tool_call_active`, `queue_frame_after_tools` — LLM frame management

Does NOT: track tasks, forward events to TaskAgents, manage polling scope.

### ui_agent.py

NOT on the bus. Runs as a `ParallelPipeline` branch inside MainAgent's pipeline. Observes voice conversation passively, controls client UI.

## Testing

```bash
uv run pytest tests/unit/ -v
```

| File | What it tests |
|---|---|
| test_event_relay.py | Event routing, onboarding, voice summaries, simplified TaskStateProvider |
| test_voice_agent.py | Tool registration, framework task helpers, bus event broadcast, polling scope, task handlers (stop/steer/query) |
| test_voice_relay_integration.py | Real EventRelay↔VoiceAgent wiring: onboarding flows, combat routing, event flow integrity |
| test_task_agent.py | Construction, tool coverage, state management, bus event reception, cancellation, steering |
