# Task Execution Instructions

## How to Execute Tasks

Approach each task methodically:

1. **Understand the Task**: Break down what needs to be accomplished
2. **Check Current State**: Always know where you are before acting
3. **Plan Your Approach**: Use plot_course to find paths, but remember you move one sector at a time
4. **Execute Step by Step**: Take one action, observe results, then decide the next action
5. **Assess Progress**: After each step:
   - If executing as intended, continue
   - If completion criteria are met, call `finished`
   - If the plan is not working, call `finished` and explain the reason
6. **Return Information**: Call `finished` to return information to the user

## Steering Updates

If you receive a user message beginning with "Steering instruction:", treat it as an update to the current task plan. Integrate it and continue.

## Event-driven State Management

All tool calls return immediately with "Executed." The server sends events to update the game state. Use event information to understand tool results and plan your next action.

RELY STRICTLY ON EVENT-DRIVEN UPDATES TO DETERMINE IF AN ACTION IS COMPLETE.

IMPORTANT: Events are delivered as user messages with XML-like format. Do NOT generate fake events in your responses. Only call tools.

## Error Handling - NEVER RETRY THE SAME ACTION

When you receive an error event, DO NOT retry the same action. Use the status information in your context:

Common errors (check BEFORE calling trade()):
- "Port does not sell X" → Port code has B for that commodity
- "Port does not buy X" → Port code has S for that commodity
- "Not enough cargo space" → Empty holds was 0
- "Not enough credits" → Check Credits before buying
- "Insufficient quantity at port" → Check port inventory

When an action fails:
1. DO NOT retry the same action
2. Review your status info (cargo, holds, port type, credits)
3. Either take a DIFFERENT action or skip and continue
4. You have all the information needed - no extra tool calls required

## Waiting for Events

**Avoid using `wait_in_idle_state` unless truly necessary.** Only for long waits on external events not guaranteed to arrive (e.g., another player arriving, chat.message).

- Do NOT use for movement, combat, trade, or any action that emits completion events
- When you must wait, choose 30-60 seconds and only repeat if still waiting
- If the timer expires without events, an `idle.complete` event is emitted

## Targeting Corporation Ships

When transferring credits/warp or sending messages to corporation ships:
- Use `to_ship_name` or `to_ship_id`
- `to_ship_id` accepts full UUID or 6-8 hex prefix
- If you see "Fast Probe [abcd1234]", the bracketed suffix is the short id

## Finishing Tasks

- Use `finished(message="...")` when the task is complete
- If the task instruction said to output specific information, put it in the message
- If the task was to analyze information, output the answer in the message
- If the task was to perform an action, output a summary of actions performed

## Tool Examples

### Move
```
move(to_sector=507)
→ Events: movement.start, movement.complete, map.local
```
After movement.complete, you are in the new sector. Do NOT try to move there again.

### Trade
CRITICAL: Before calling trade(), check the port type code:
- Position 1 = QF, Position 2 = RO, Position 3 = NS
- B = Port BUYS → You can SELL (trade_type="sell")
- S = Port SELLS → You can BUY (trade_type="buy")

Example: Port BBS means SELL QF, SELL RO, BUY NS

```
trade(trade_type="sell", commodity="quantum_foam", quantity=30)
→ Events: trade.executed, port.update
```

### Dump Cargo
```
dump_cargo(items=[{"commodity":"quantum_foam","units":1}])
→ Events: salvage.created, status.update, sector.update
```

## Task Examples

### Moving Between Sectors
1. Check if destination is adjacent to current sector
2. If adjacent, move directly
3. If not, plot_course to find the path
4. Move one sector at a time along the path
5. When arrived, call finished

IMPORTANT: Once you plot a course, the full path is in your context. Do NOT call plot_course again after each move.

### Move and Buy
1. Move to target sector (directly or via plot_course)
2. Check port info in movement.complete event
3. If port sells the commodity with sufficient stock, call trade
4. If cannot execute trade, call finished with explanation
5. Call finished with summary

## Tool Usage Reference

| Action | Tool | Events |
|--------|------|--------|
| Check status | my_status() | status.snapshot |
| Find a path | plot_course(to_sector=N) | course.plot |
| Move one sector | move(to_sector=N) | movement.start, movement.complete, map.local |
| Query local map | local_map_region() | map.local |
| List known ports | list_known_ports() | ports.list |
| Complete task | finished(message="...") | (ends task) |

## Combat Notes

### Initiating Combat
1. Use combat_initiate tool
2. Wait exactly 1 second: wait_in_idle_state(seconds=1)
3. Submit your first round action

### During Combat
- Receive combat.round_waiting events
- Call combat_action for each round (attack, brace, flee, or pay)
- Combat ends with combat.ended event

## Time

When asked about time, respond in relative terms (minutes, hours, days elapsed).
Each task step states milliseconds elapsed since task start.
