# Combat Mechanics

## Overview

Combat begins whenever armed ships or garrisons share a sector and an encounter is initiated. Combat proceeds in timed rounds; missing a deadline defaults your action to BRACE.

Combat is disabled in Federation Space (fedspace).

## Round Actions

Each round, every participant declares one action:

### ATTACK
- Commit a number of fighters and specify a valid target
- Each committed fighter rolls once
- Hits destroy one enemy fighter; misses cost the attacker a fighter
- Invalid targets or zero commits degrade to BRACE

### BRACE
- Defensive posture that commits no fighters
- Increases shield mitigation by 20% (capped at 50%)
- Reduces shield ablation by 20% for the round

### FLEE
- Player-controlled ships (not garrisons or escape pods) pick an adjacent sector to escape toward
- Success probability ranges from 20% to 90%
- Improves when your turns_per_warp exceeds your opponent's
- Successful fleers exit combat immediately

### PAY
- Offer credits to toll garrisons
- Successful payments mark the toll satisfied
- If everyone braces afterward, the encounter concludes peacefully

## Round Timing

- Rounds normally take 15 seconds
- After you submit your action, wait for combat update events to arrive
- If you miss the deadline, your action defaults to BRACE

## Damage, Shields, and Order

### Attack Order
- Attack order favors combatants with more fighters
- Then higher turns_per_warp
- Larger commitments swing first

### Hit Chance
- Base hit chance is roughly 50%
- Enemy shields and BRACE reduce that chance
- Your own shields add a small bonus
- Final odds stay between 15% and 85%

### Defensive Losses
- Defensive losses remove fighters immediately
- Shields ablate by about half the incoming hits (less while bracing)
- Lower shields weaken mitigation in future rounds

## Ending the Fight

Encounters conclude when:
- Opponents are destroyed
- One side flees
- Combatants stand down (including toll payments)

### Possible End States
- `victory` - You won
- `<combatant>_defeated` - Specific combatant was destroyed
- `mutual_defeat` - Both sides destroyed
- `<combatant>_fled` - Specific combatant escaped
- `stalemate` - Fight ended without resolution
- `toll_satisfied` - Toll was paid and accepted

## Strategy Tips

- **BRACE** when outnumbered, buying time for allies, or rebuilding shields
- **Attack** only with the fighters you can afford to lose
- Probe with small commits before committing everything
- **FLEE** toward safe adjacent sectors when your fighters or shields are nearly depleted and you have better warp agility
- **PAY** tolls when a garrison blocks progress and combat is unwinnable
- Once the toll clears, a round of universal BRACE ends the encounter
- Watch for each `combat.round_waiting` event and submit your action before the timer expires

## Combat Flow in Tasks

### Initiating Combat
1. Use the combat_initiate tool
2. Wait for one second exactly: wait_in_idle_state(seconds=1)
3. Submit your first round action

### During Combat
- Receive combat.round_waiting events
- Call combat_action for each round
- Provide: combat_id, action, and when attacking: commit and target_id
- When fleeing: provide to_sector

### Combat Ends
- Receive combat.ended event
- Check the result in the event payload
- Continue with the task if applicable

## Combat Action Tool

```
combat_action(
    combat_id="...",      # From combat events
    action="attack",      # attack, brace, flee, pay
    commit=50,            # Fighters to commit (for attack)
    target_id="...",      # Target combatant (for attack)
    to_sector=123,        # Escape sector (for flee)
    round_number=1        # Optional concurrency control
)
```
