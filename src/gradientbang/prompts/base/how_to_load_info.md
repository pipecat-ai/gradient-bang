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

Load detailed info when executing or answering questions about specific game mechanics.

## When to Load Event Logs

Before planning a historical lookup task, load `load_game_info(topic="event_logs")`.

This includes questions like:
- who visited/entered/left a sector
- what happened in a sector over time (last hour/day/since X)
- garrison/toll fighter activity ("my fighters in sector X", "toll fighters")
- arrivals, departures, toll encounters, or flee outcomes
