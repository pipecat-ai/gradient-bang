# CLAUDE.md

## Project overview

Gradient Bang is an online multiplayer universe where gameplay and systems are driven by AI agents. The stack includes:

- Supabase (edge functions + database) for the game server
- Python services (bot + agents)
- Web client in `client/`

## Repository focus areas

Most important code in this repo:

- `src/gradientbang/pipecat_server/bot.py` - pipeline wiring, MainAgent (inline), client message handlers
- `src/gradientbang/pipecat_server/subagents/` - VoiceAgent, EventRelay, TaskAgent, UIAgent
- `deployment/supabase/functions/` - all game server logic
- `client/` - web client for the game

## Bot architecture

`bot.py` creates all components and wires them together:

- **MainAgent** (inline in `bot.py`) - `BaseAgent` owning transport pipeline (STT/TTS) with `BusBridgeProcessor`
- **VoiceAgent** (`subagents/voice_agent.py`) - `LLMAgent` with 16 game tools; spawns TaskAgent children per task, broadcasts game events to bus
- **TaskAgent** (`subagents/task_agent.py`) - `LLMAgent` with 31 game tools; self-contained autonomous agent, receives events via bus
- **EventRelay** (`subagents/event_relay.py`) - single game event subscriber, declarative routing engine; feeds VoiceAgent which distributes to TaskAgents via bus
- **UIAgent** (`subagents/ui_agent.py`) - parallel pipeline branch for autonomous UI control (not on bus)

Tool schemas are defined once in `src/gradientbang/tools/` and shared by VoiceAgent, TaskAgent, and UIAgent.

See `src/gradientbang/pipecat_server/subagents/CLAUDE.md` for detailed architecture docs.

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

## Testing

- **Python Unit tests** (no server needed): `uv run pytest -m unit`
- **Python integration tests** (requires DB): `bash scripts/run-integration-tests.sh`
- **Edge function integration tests** (Deno): `bash deployment/supabase/functions/tests/run_tests.sh`

The Python integration test script spins up an isolated Supabase instance on different ports (54421+), seeds it via the `test_reset` edge function, runs `pytest -m integration`, and tears everything down. It does NOT touch the dev database. Pass extra pytest args after the script: `bash scripts/run-integration-tests.sh -v -k "test_movement"`.
