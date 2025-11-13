# Voice AI Meetup - November 25

**Slides**

https://drive.google.com/file/d/1AEb5_ljHXQao-dw1Na_KWZlDb05mDEuu/view?usp=sharing

**Panel**

* [Arjun Desai](https://x.com/jundesai)
* [John Alioto](https://x.com/jpalioto)
* [Taruni Paleru](https://x.com/tarunipaleru)
* [Kwindla Hultman Kramer](https://x.com/kwindla)

----

<img width="640" src="docs/image.png" style="margin-bottom:20px;" />

Gradient Bang is an online multiplayer universe where you explore, trade, battle, and collaborate with other players and with LLMs. Everything in the game is an AI agent, including the ship you command.

The projects demonstrates the full capabilities of realtime agentic workflows, such as multi-tasking, advanced tool calling and low latency voice.


# Quickstart

#### 1. Run Universe Bang to generate a world

```bash
mkdir world-data
uv run scripts/universe-bang.py 5000 1234
```

#### 1. Start the game server

```bash
uv run game-server/server.py
```

#### 3. Create your character (note: game server must be running!)

```bash
uv run scripts/character_create.py
```

#### 4. Optional: Create a `.env` file and restart game server:

```bash
mv env.example .env
# Set all fields
# Get character_id from world-data/characters.json
uv run game-server/server.py
```

#### 5. Run the Pipecat agent

```bash
uv run pipecat_server/bot.py
```

#### 6. Run the web client

```bash
cd client/
pnpm i
pnpm run dev
```

#### 7. Spawn NPCs to interact with

```bash
# Create a new player
uv run scripts/character_create.py 

# Test alle is gud by looking up the character
uv run -m scripts.character_lookup "TestPlayer"

# Run the NPC and tell it what to do
uv run npc/run_npc.py <character_id> "Travel to sector 0 and send a message to player TraderP saying hello!"
```

# Notes

## Character identity & admin tools

Gradient Bang now separates immutable **character UUIDs** from human-friendly **display names**. Start the bot with a UUID.

Create character interactively

```
uv run -m scripts.character_create
```

Run the bot for a character

```
PIPECAT_CHARACTER_ID=`uv run -m scripts.character_lookup "Joe Player"` uv run -m pipecat_server.bot
```

Run an autopilot task

```
LOGURU_LEVEL=DEBUG uv run npc/run_experimental_task.py `uv run -m scripts.character_lookup "Big Slim"` "Wait for 30 seconds. When finished, print out each event received."
```


- Use `uv run scripts/character_lookup.py "Display Name"` to fetch the UUID for an existing pilot.
- Use `uv run scripts/character_modify.py` to adjust registry fields (name, credits, ship stats). The script prompts for the admin password and desired changes before issuing `character.modify`.
- Any automation (NPC TaskAgent, Simple TUI, Pipecat voice bot, etc.) must authenticate with the UUID, even though the UI copy will use the display name.

## Corporation ship control

- All corp ship automation must supply two IDs: the **actor** (a corporation member controlling the ship) and the **target ship** (whose `ship_id` equals its `character_id`). Every CLI helper below enforces this pairing, and the server will reject requests that omit or mismatch the actor.
- List fleet status and copy a ship ID:  
  `uv run scripts/corporation_lookup.py <member_id> --ships`
- Run the TaskAgent against a corp vessel:  
  `uv run npc/run_npc.py <member_id> --ship-id ship-abc123 "Scan nearby sectors"`
- The first positional argument in `run_npc.py` is the actor; when `--ship-id` is present it must be a corp member allowed to command the vessel.
- Join from the Simple TUI with the ship's `character_id`:  
  `uv run npc/simple_tui.py --character-id ship-abc123 --actor-id corp-member-01 --server http://localhost:8000`
- If `Control: BLOCKED` appears in the lookup output, create `world-data/character-map-knowledge/ship-abc123.json` (rerun the provisioning step or copy from another ship) before launching agents.
- In the TUI, use `/ships` to list the fleet and `/shipcopy <ship_id>` to copy an identifier.
- See `docs/operator_quick_ref.md` for a compact checklist covering the core operator flows.

## Create a universe

```
mkdir world-data
uv run scripts/universe-bang.py 5000 1234
```

## Run the game server

```
uv run game-server/server.py
```


## Bot that sends RTVI messages

This bot implements some of the task handling and RTVI messages needed to implement the same functionality as the TUI. Configure the pilot it controls with environment variables before launching:

```
export PIPECAT_CHARACTER_ID="uuid-from-registry"
export PIPECAT_CHARACTER_NAME="Trader P"  # optional label for prompts/logs
```

```
uv run pipecat_server/bot.py
```

## Run the client dev server

```
cd client
npm i
npm run dev
```

## NPC Combat CLIs

Two new command-line utilities support live combat monitoring and automation. Both expect `GOOGLE_API_KEY` to be set and default to WebSocket transport.

- **Interactive controller** – prompts for each round and is safe to run without an API key:

  ```
  uv run npc/combat_interactive.py 42 --character NPC_Fox
  ```

  The script moves the character to sector `42`, waits for other pilots, and lets you choose between `fight`/`wait`, then per-round actions (`attack`, `brace`, `flee`).

- **Strategy controller** – drives combat decisions with the TaskAgent and a strategy prompt:

  ```
  uv run npc/combat_strategy.py 42 fight "Favor attack when shields > 50%." --character NPC_Fox
  ```

  Modes: `fight` (auto-initiate when someone arrives) or `wait` (hold position until attacked). Use `--model` / `--action-timeout` to tune behaviour. The agent receives structured battle snapshots and must respond via the combat tools.

## Local map visualization

New component HudMapVisualization.tsx has been badly glued into the HUD.

You can test the graph rendering logic by loading http://localhost:5173/map-demo.html

## Testing

### Running AsyncGameClient Integration Tests

The AsyncGameClient integration tests verify that all API methods work correctly against a running server. These tests require a live server instance.

**Start the game server:**

```bash
uv run python -m game-server
```

**In a separate terminal, run the tests:**

```bash
uv run pytest tests/test_async_game_client.py -v
```

The test suite includes 25 tests covering:
- Join and authentication
- Movement and pathfinding
- Status queries
- Map knowledge
- Trading operations
- Combat operations
- Messaging
- Character ID validation

**Run all tests:**

```bash
uv run pytest
```

# NOTE

There is now a tool_call stared RTVI message, followed by a 2-second delay before the tool call completes.

See GameContext.tsx line 366, and the console.log line

  `[TOOL] Tool call started [move|trade|recharge_warp_power|transfer_warp_power]`

The delays are specified in VoiceTaskManager::TOOL_CALL_DELAYS.

This should allow us to fix the warp overlay and other UI timing stuff, maybe.




# OLD

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

NPC runners must now authenticate with a real character UUID from the registry. Use the lookup/modify scripts described above to find or adjust entries (e.g., `uv run scripts/character_lookup.py "Trader P"`).

Give that character something to do. GPT-5 will try to follow your instructions once `OPENAI_API_KEY` is set.

```
export GOOGLE_API_KEY=...
```

```
uv run npc/run_npc.py 2b4ff0c2-1234-5678-90ab-1cd2ef345678 "Move to sector 1000. Once you get there, summarize everything you've seen along the way."
```

`npc/simple_tui.py` shares the same requirement. Pass `--character-id` (or set `NPC_CHARACTER_ID`) so the UI joins with the immutable identifier while the logs display the friendly name learned from status events.

# Todo

* [ ] universe-bang should create the world-data directory if necessary and write output files there.


## Textual UI for the game

Once the console starts, close the debug panel (ctrl+d). Then try running a task like "Navigate on auto-pilot to sector 1000." Always provide the UUID:

```
export GOOGLE_API_KEY=sk-proj-...
uv run npc/simple_tui.py --character-id 2b4ff0c2-1234-5678-90ab-1cd2ef345678 --server http://localhost:8000
```

The Simple TUI pulls display names from `status.snapshot`, so the UI shows names even though all RPCs keep using the UUID behind the scenes.


## License

The **source code** for Gradient Bang is licensed under the [Apache License 2.0](LICENSE), making it fully open source for commercial and non-commercial use.

**Visual assets, artwork, and audio** are licensed under the [Creative Commons Attribution 4.0 International License (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/), allowing free use with attribution.

The **Gradient Bang name, logo, and brand identity** are proprietary trademarks and not covered by the open source licenses. If you fork this project, you must rename it and create your own brand identity. See [TRADEMARKS.md](TRADEMARKS.md) for complete details.
