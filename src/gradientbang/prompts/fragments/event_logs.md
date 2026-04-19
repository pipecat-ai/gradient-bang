# Event Log Querying

## Overview

You can query historical event data to answer questions about past activity using the `event_query` tool.

## Time Ranges

- "yesterday" = previous day from UTC 00:00:00 to 23:59:59
- "today" = current day from UTC 00:00:00 to now
- "last hour" = current time minus 1 hour
- Always use ISO8601 format: "2025-01-14T00:00:00Z"

## Query Efficiency - Use Filters First

Always prefer specific filters over broad queries to minimize context usage.

| Goal | Efficient | Inefficient |
|------|-----------|-------------|
| Find task starts | filter_event_type="task.start" | filter_string_match="task.start" |
| Most recent trade | filter_event_type="trade.executed", sort_direction="reverse", max_rows=1 | fetch all events |
| Events from task X | filter_task_id="<uuid>" | fetch all events and filter |
| Find an anchor by keyword | filter_event_type + filter_string_match | bare filter_string_match across all event types |

Important:
- ALWAYS set `filter_event_type`, `filter_task_id`, or `filter_sector`. Never run a query without at least one of these filters — unfiltered queries return too much data and will fail.
- Never use a bare `filter_string_match` query without `filter_event_type`.
- When searching for a named ship, purchase, or other keyword, use `filter_event_type="task.finish"` + `filter_string_match`.

## Two-Step Pattern for Task Analysis

For questions about specific tasks, use a two-step approach:

### Example: "Summarize my most recent exploration task"

**Step 1 - Find the task:**
```
event_query(
    start="2025-01-14T00:00:00Z",
    end="2025-01-15T00:00:00Z",
    filter_event_type="task.start",
    filter_string_match="explor",
    sort_direction="reverse",
    max_rows=1
)
```
Extract the task_id from the returned task.start event.

**Step 2 - Get all events for that task:**
```
event_query(
    start="2025-01-14T00:00:00Z",
    end="2025-01-15T00:00:00Z",
    filter_task_id="<task_id from step 1>"
)
```
This returns all events logged during that task execution.

## Common Query Patterns

### Find most recent event of a type
```
event_query(
    start=..., end=...,
    filter_event_type="<type>",
    sort_direction="reverse",
    max_rows=1
)
```

### Find tasks matching a keyword
```
event_query(
    start=..., end=...,
    filter_event_type="task.start",
    filter_string_match="<keyword>",
    sort_direction="reverse"
)
```

### Get complete task history
```
event_query(
    start=..., end=...,
    filter_task_id="<uuid>"
)
```

### Analyze trades from a specific task
```
event_query(
    start=..., end=...,
    filter_event_type="trade.executed",
    filter_task_id="<uuid>"
)
```

## Session-Relative Questions

`session.started` events mark when the player joined the game. Use them to bound sessions.

### "What did I do last session?"

If your context includes "Current session started at {T}", use T as the current session boundary. Query `session.started` events BEFORE T to find the previous session:

```
event_query(
    start=<7 days ago>, end=<T>,
    filter_event_type="session.started",
    sort_direction="reverse",
    max_rows=1
)
```
"Last session" = the returned timestamp → T. If no results, use T minus 24 hours → T.

Then get activity in that window:
```
event_query(
    start=<previous session.started>, end=<T>,
    filter_event_type="task.finish",
    sort_direction="forward"
)
```
Task summaries are usually sufficient. Only query `trade.executed`, `bank.transaction`, etc. if task summaries lack detail.

### "What happened in the session where I bought the Aegis?"

Step 1 — Find the anchor. For personal ship purchases, use the dedicated event type:
```
event_query(
    start=<7 days ago>, end=<now>,
    filter_event_type="ship.purchased",
    filter_string_match="Aegis",
    sort_direction="reverse",
    max_rows=1
)
```
For corp ship purchases use `corporation.ship_purchased` instead. If the dedicated event type returns 0, fall back to `task.finish` + `filter_string_match`.

Step 2 — Find the `session.started` before and after the anchor:
```
event_query(
    start=<anchor - 7d>, end=<anchor timestamp>,
    filter_event_type="session.started",
    sort_direction="reverse",
    max_rows=1
)
```
```
event_query(
    start=<anchor timestamp>, end=<anchor + 7d>,
    filter_event_type="session.started",
    sort_direction="forward",
    max_rows=1
)
```

Step 3 — Query `task.finish` between those two boundaries.

## Garrison Sector Activity Playbook

Use these rules when the user asks about activity in a garrisoned sector.

### Visitor list (who was in sector X)
Use:
```
event_query(
    start=..., end=...,
    event_scope="corporation",
    filter_sector=<sector_id>,
    filter_event_type="garrison.character_moved",
    sort_direction="reverse",
    max_rows=100
)
```
Then:
- Keep `movement="arrive"` for arrivals/visits
- Exclude self only if the user asked for non-self visitors
- Paginate until `has_more` is false

### Toll fighter actions (demand/pay/flee context)
Run additional queries in the same time window and sector:
```
event_query(
    start=..., end=...,
    event_scope="corporation",
    filter_sector=<sector_id>,
    filter_event_type="combat.round_resolved",
    sort_direction="reverse",
    max_rows=100
)
```
```
event_query(
    start=..., end=...,
    event_scope="corporation",
    filter_sector=<sector_id>,
    filter_event_type="combat.ended",
    sort_direction="reverse",
    max_rows=100
)
```
Use payload fields like `result`, `flee_results`, and `fled_to_sector` to report toll stand-down/flee outcomes.

### All activity in a sector (not just visits)
If asked for all activity, do not set `filter_event_type`:
```
event_query(
    start=..., end=...,
    event_scope="corporation",
    filter_sector=<sector_id>,
    sort_direction="reverse",
    max_rows=100
)
```
Then paginate until `has_more` is false.

## Ship Destruction Playbook

Use these steps when the player asks why their ship was destroyed or about a destruction event.

### "Why was my ship destroyed?" / "What destroyed my ship?"

Step 1 — Find the destruction event:
```
event_query(
    start=<7 days ago>, end=<now>,
    filter_event_type="ship.destroyed",
    filter_string_match="<ship_name if known>",
    sort_direction="reverse",
    max_rows=1
)
```
The payload contains `combat_id`, `sector`, `player_name`, `ship_type`, and `salvage_created`.

Step 2 — Get combat details using the `combat_id` from step 1:
```
event_query(
    start=<destruction timestamp - 1h>, end=<destruction timestamp + 1m>,
    filter_event_type="combat.ended",
    filter_string_match="<combat_id>"
)
```
The `combat.ended` payload contains the full outcome: `result`, `participants`, round logs, and `flee_results`.

Step 3 (optional) — For round-by-round breakdown:
```
event_query(
    start=<destruction timestamp - 1h>, end=<destruction timestamp + 1m>,
    filter_event_type="combat.round_resolved",
    filter_string_match="<combat_id>"
)
```

For corp ship destruction, use `event_scope="corporation"` in step 1.

## Filter Parameters

All filter parameters use the `filter_` prefix:

- **filter_event_type**: Specific event type (e.g., "task.start", "trade.executed")
- **filter_task_id**: Events from a specific task (full UUID or 6-char short ID)
- **filter_sector**: Events within a sector
- **filter_string_match**: Literal substring search in payloads

## Other Parameters

- **sort_direction**: "forward" (chronological) or "reverse" (newest first)
- **max_rows**: Limit results (default 100, max 100). Prefer smaller values unless you truly need a wide scan.
- **cursor**: For pagination (use next_cursor from previous response)
- **event_scope**: "personal" or "corporation"

## Common Event Types

| Event Type | Contains |
|------------|----------|
| trade.executed | commodity, units, price, total_price, trade_type |
| movement.complete | sector arrivals, first_visit flag |
| garrison.character_moved | arrivals/departures detected by garrisons (includes player + movement) |
| combat.ended | combat results (result, participants, flee_results) |
| combat.round_resolved | per-round combat detail (hits, losses, shields, fighters, actions) |
| bank.transaction | deposits/withdrawals |
| warp.purchase | warp power recharges |
| task.start | task_description, task_id |
| task.finish | task_summary, task_status |
| session.started | session boundary marker (sector, ship_name, ship_type) |
| ship.purchased | personal ship purchase (ship_type, ship_name, purchase_price, net_cost, old_ship_type) |
| ship.traded_in | personal ship trade-in detail (old_ship_type, new_ship_type, price, trade_in_value) |
| ship.destroyed | ship destroyed in combat (ship_name, ship_type, player_name, combat_id, sector, salvage_created) |
| corporation.ship_purchased | corp ship purchase (ship_type, ship_name, purchase_price, buyer_name) |

## Calculating Trade Profit

From trade.executed events:
1. Filter for trade_type="sell" events and sum total_price = total revenue
2. Filter for trade_type="buy" events and sum total_price = total cost
3. Profit = revenue - cost
4. Break down by commodity if needed

## Pagination

If `has_more: true` in response:
- Use `next_cursor` value in the next query
- Continue until `has_more: false`

## Event Scope

- **personal** (default): Your own events, plus events explicitly delivered to you via visibility rules (including garrison visibility events like `garrison.character_moved`)
- **corporation**: Events for all corp members and corp-tagged events
