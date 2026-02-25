# NPC

Runs an autonomous AI task agent as a game character. Resolves a character name to its UUID, then launches the `npc-run` script which connects to the game server and executes the given task using a Pipecat + Gemini LLM pipeline.

## Parameters

- **character_name** (required): The character's display name (e.g. `JOETRADER`). Passed as the argument to `/npc`.
- **task** (required): A natural language description of what the character should do (e.g. "Explore and find 5 new sectors").

If `character_name` is not provided as an argument, ask the user for it. Always ask the user for the `task` description.

## Steps

### 1. Source environment variables

```bash
set -a && source .env.supabase && set +a
```

### 2. Resolve the character UUID

Look up the character by name using Supabase REST:

```bash
curl -s "${SUPABASE_URL}/rest/v1/characters?name=eq.<character_name>&select=character_id,name" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"
```

This returns a JSON array. Extract the `character_id` from the first result. If no results are returned, report that the character was not found and stop.

### 3. Run the NPC task agent

Run the `npc-run` script with the resolved character ID and the task. Redirect all output to a log file (do NOT use `tee`):

```bash
uv run npc-run <character_id> "<task>" > logs/npc-<character_name>.log 2>&1 &
NPC_PID=$!
echo "NPC agent started with PID $NPC_PID, logging to logs/npc-<character_name>.log"
```

Run the process in the background so it doesn't block the conversation.

### 4. Report to the user

Show the user:
- Character name and resolved UUID
- The task being executed
- The PID and log file path
- How to check progress: `tail -f logs/npc-<character_name>.log`
- How to stop the agent: `kill <PID>`

## Important notes

- Environment variables `GOOGLE_API_KEY` and `SUPABASE_URL` must be set (they come from `.env.supabase`).
- Edge functions must be running: `npx supabase functions serve --workdir deployment --no-verify-jwt --env-file .env.supabase`
- The NPC agent runs autonomously and calls `finished()` when the task is complete.
- All output MUST go to a log file. Do NOT use `tee`. Use `tail`, `head`, or `grep` to inspect the log.
- The character must already exist in the game and have joined (has a ship, is in a sector).
- For corporation ship control, the user can provide a `--ship-id` flag manually if needed.
