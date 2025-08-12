# Notes

## Create a universe

```
mkdir world-data
cd world-data
uv run ../scripts/universe-bang.py 5000 1234
cd ..
```

## Run the game server

```
uv run game-server/server.py
```

## Textual UI for the game

Once the console starts, close the debug panel (ctrl+d). Then try running a task like "Navigate on auto-pilot to sector 1000."

```
export OPENAI_API_KEY=sk-proj-...
uv run player_tui.py JoePlayer
```

## Bot that sends RTVI messages

This bot implements some of the task handling and RTVI messages needed to implement the same functionality as the TUI.

```
uv run pipecat/bot.py
```



----

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
