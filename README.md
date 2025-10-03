<img width="640" src="docs/image.png" style="margin-bottom:20px;" />

# Quickstart

1. Create `.env` file in root directory (if using Pipecat bot)
2. Generate world data (universe bang)
3. Run the game server
4. Run the Pipecat bot and client *or* TUI client

```bash
# .env
OPENAI_API_KEY=
DEEPGRAM_API_KEY=
CARTESIA_API_KEY=
```

### VS Code 

Run the dev environment task with `cmd+shift+b` (Runs the `Dev Environment`build task. Manually accessible via `Terminal/Run Task...` )

This will generate world data if non-existent, then the Python processes and web client.

### Manual

**Generate universe and player data**

```
mkdir world-data
uv run scripts/universe-bang.py 5000 1234
```

**Run the game server process**

```
uv run src/game-server/server.py
```

**Run bot process**

```
uv run src/pipecat/bot.py
```

**Run the client dev server**

```
cd clients/web
pnpm i
pnpm run dev
```

*Note: `npm i` and `npm run dev` works too if you do not have pnpm installed. pnp, is recommended as lockfile included.*


## Clients

### Web (graphical)

`clients/web`

Requires you run the Pipecat bot that implements some of the task handling and RTVI messages

```
uv run pipecat/bot.py

cd clients/www
pnpm i
pnpm run dev
```

### TUI (textual)

`clients/tui`

**Note: the TUI does not load the .env - you must export the LLM key in the terminal process first!**

```
export OPENAI_API_KEY=sk-proj-...
uv run clients/tui/player_tui.py JoePlayer
```

Once the console starts, close the debug panel (ctrl+d). Then try running a task like "Navigate on auto-pilot to sector 1000."


# OLD

There is now a tool_call stared RTVI message, followed by a 2-second delay before the tool call completes.

See GameContext.tsx line 366, and the console.log line

  `[TOOL] Tool call started [move|trade|recharge_warp_power|transfer_warp_power]`

The delays are specified in VoiceTaskManager::TOOL_CALL_DELAYS.

This should allow us to fix the warp overlay and other UI timing stuff, maybe.


## Open firehose viewer

This is the stub for an admin tool.

```
uv run tools/firehose_viewer.py
```

## Open the character viewer

Sort of another admin tool / maybe mostly just a way to test some of the Python client library code.

```
uv run tools/character_viewer.py
```

## Give an NPC something to do

Make up a unique ID for an NPC. (There are no controls on characters joining the game, yet, so you can just pick any string as the ID.)

Give that character something to do. GPT-5 will try to follow your instructions.

```
export OPENAI_API_KEY=...
```

```
uv run npc/run_npc.py TraderX "Move to sector 1000. Once you get there, summarize everything you've seen along the way."
```


# Todo

* [ ] universe-bang should create the world-data directory if necessary and write output files there.


## Textual UI for the game

Once the console starts, close the debug panel (ctrl+d). Then try running a task like "Navigate on auto-pilot to sector 1000."

```
export OPENAI_API_KEY=sk-proj-...
uv run player_tui.py JoePlayer
```
