# CLAUDE.md

## Project overview

Gradient Bang is an online multiplayer universe where gameplay and systems are driven by AI agents. The stack includes:

- Supabase (edge functions + database) for the game server
- Python services (bot + agents)
- Web client in `client/`

## Repository focus areas

Most important code in this repo:

- `src/gradientbang/bot.py` - Pipecat session entrypoint and voice pipeline wiring
- `src/gradientbang/runtime/` - Orchestrator, EventRelay, client messages, task agents, BYOA, bus protocol
- `src/gradientbang/game/` - game API client and event transport adapters
- `deployment/supabase/functions/` - all game server logic
- `client/` - web client for the game

## Bot architecture

Core runtime shape:

- The web client connects to the bot over WebRTC. Audio uses the WebRTC transport; RTVI messages flow both ways for client/server events and custom client messages.
- `bot.py` builds the live Pipecat voice pipeline: transport, STT, voice LLM, TTS, aggregators, and the `player` `PipelineWorker`.
- The `player` worker owns Pipecat lifecycle and bus identity. The voice LLM runs inline in this pipeline.
- `Orchestrator` is a plain Python coordinator attached to the `player` worker. It owns session bootstrap, voice tools, client-message routing, event relay integration, task lifecycle, BYOA, and shutdown.
- `AsyncGameClient` calls Supabase Edge Functions and manages session-scoped pubsub event delivery.
- Edge Functions mutate database state and emit game events. The database is the source of truth for world state, ships, corporations, tasks, events, and BYOA config.
- `EventRelay` receives game events and routes them to RTVI, voice LLM context, and the subagent bus.
- `VoiceRuntime` binds the voice tool schema to Orchestrator handler methods.
- `TaskAgent` workers are children of the `player` worker and communicate with Orchestrator over bus messages.
- BYOA agents use the same bus protocol as in-process task agents, but are externally hosted and woken by the runtime.

Tool schemas live in `src/gradientbang/runtime/tool_schema.py`.

## Local dev (quick)

- Start Supabase locally:
  - `npx supabase start --workdir deployment/`
- Run edge functions locally:
  - `npx supabase functions serve --workdir deployment --no-verify-jwt --env-file .env.supabase`
- Start the bot:
  - `set -a && source .env.supabase && set +a && uv run bot --host 0.0.0.0`

## Important notes

- Supabase edge functions are the only backend.
- You can look directly at Supabase tables and Supabase logs for Supabase running locally. Config is `.env.supabase`.
- Supabase command is `npx supabase --workdir deployment`.
- To run Supabase edge functions: `npx supabase functions serve --workdir deployment --no-verify-jwt --env-file .env.supabase`.
- To start the bot: `set -a && source .env.supabase && set +a && uv run bot --host 0.0.0.0`.
- If you need to run edge functions or start the bot, redirect ALL output to a file. Do NOT use `tee`; use `head`, `tail`, `grep`, etc. to inspect log files.
- All Python env vars are inventoried in `src/gradientbang/config.py`. When adding or removing an env var anywhere in the Python code, keep that file in sync.

## Testing

- **Python Unit tests** (no server needed): `uv run pytest -m unit`
- **Python integration tests** (requires DB): `bash scripts/run-integration-tests.sh`
- **Edge function integration tests** (Deno): `bash deployment/supabase/functions/tests/run_tests.sh`

The Python integration test script spins up an isolated Supabase instance on different ports (54421+), seeds it via the `test_reset` edge function, runs `pytest -m integration`, and tears everything down. It does NOT touch the dev database. Pass extra pytest args after the script: `bash scripts/run-integration-tests.sh -v -k "test_movement"`.

## Pull requests

When opening a PR on GitHub, the description must contain only:

- A few sentences at the top describing the problem being solved.
- Terse, succinct bullet points summarizing the changes.

Do not include a test plan, "Generated with Claude Code" footnote, or any other sections.
