# CLAUDE.md

## Project overview

Gradient Bang is an online multiplayer universe where gameplay and systems are driven by AI agents. The stack includes:

- Supabase (edge functions + database) for the game server
- Python services (bot + agents)
- Web client in `client/`

## Repository focus areas

Most important code in this repo:

- `src/gradientbang/voice/VoiceTaskManager` - core of the voice bot
- `src/gradientbang/tasks/TaskAgent` - long-running task harness
- `deployment/supabase/functions/` - all game server logic
- `client/` - web client for the game

## Local dev (quick)

- Start Supabase locally:
  - `npx supabase start --workdir deployment/`
- Run edge functions locally:
  - `npx supabase functions serve --workdir deployment --no-verify-jwt --env-file .env.supabase`
- Start the bot:
  - `set -a && source .env.supabase && set +a && uv run bot --host 0.0.0.0`

## Testing the web client

- Open a browser and load http://localhost:5173/
- Sign in as kwindla@gmail.com with password secret123
- Use the player JOETRADER

## Critical: Read-only directories

- `pipecat-core-source/` is READ ONLY reference code. It is NOT loaded as a dependency. NEVER modify files in this directory. Use it only to understand pipecat internals.

## Critical: Read-only directories

- `pipecat-core-source/` is READ ONLY reference code. It is NOT loaded as a dependency. NEVER modify files in this directory. Use it only to understand pipecat internals.

## Important notes

- Legacy game_server code has been removed. Supabase edge functions are the only backend.
- You can look directly at Supabase tables and Supabase logs for Supabase running locally. Config is `.env.supabase`.
- Supabase command is `npx supabase --workdir deployment`.
- To run Supabase edge functions: `npx supabase functions serve --workdir deployment --no-verify-jwt --env-file .env.supabase`.
- To start the bot: `set -a && source .env.supabase && set +a && uv run bot --host 0.0.0.0`.
- If you need to run edge functions or start the bot, redirect ALL output to a file. Do NOT use `tee`; use `head`, `tail`, `grep`, etc. to inspect log files.
