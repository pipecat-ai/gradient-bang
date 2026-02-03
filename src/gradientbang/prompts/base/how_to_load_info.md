# Loading Detailed Game Information

When you need in-depth rules or mechanics for a specific game system, use the `load_game_info` tool to load detailed information.

## Available Topics

- **exploration** - Map knowledge, navigation strategies, sector discovery
- **trading** - Port codes, trade calculations, opportunistic trading
- **combat** - Combat actions, rounds, damage, strategies
- **corporations** - Creating, joining, managing corporations
- **transfers** - Warp power and credits transfers between ships
- **ships** - Ship types, purchasing, capabilities
- **event_logs** - Querying historical game logs, event patterns

## When to Use

Load detailed information when:
- You need to execute a complex trading sequence
- Combat is initiated and you need tactical guidance
- The pilot asks about specific game mechanics
- You're planning a multi-step task involving unfamiliar systems

## Example Usage

If the pilot asks to "trade on the way" during exploration, load the trading topic:
```
load_game_info(topic="trading")
```

If combat begins unexpectedly:
```
load_game_info(topic="combat")
```
