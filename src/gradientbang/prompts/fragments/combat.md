# Combat Mechanics

## Overview

Combat begins whenever armed ships or garrisons share a sector and an encounter is initiated. Combat proceeds in timed rounds; missing a deadline defaults your action to BRACE.

Combat is disabled in Federation Space (fedspace).

Any non-friendly ship, corporation ship, or garrison in your sector is a valid target.

## Participating vs Observing

You receive combat events in two modes — check the opening line to tell which:

- **DIRECT** — You're a combatant. Opening line: `Combat state: you are currently in active combat`. You MUST call `combat_action` each round or timeout defaults to BRACE.
- **OBSERVED** — Your garrison or corp ship is in a fight, but you aren't personally. Opening line: `Your garrison has engaged` / `Your corp's ship has entered combat` / `Your corp's garrison has engaged`. Do NOT call `combat_action` — you're not fighting. Voice announces once on combat start, stays silent through updates; answer follow-ups from context.

Observed events are context, not a call to action.

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

- Offer credits to a toll garrison
- Payment is a peace contract with THAT garrison, scoped to YOU only
- After paying, you cannot attack that garrison (rejected) and it cannot target you
- Other hostiles in the combat keep fighting until they pay, flee, or are destroyed
- Combat ends `toll_satisfied` when every hostile has paid AND no one is attacking
- Never re-pay a garrison you've already paid — rejected

## Reading Event Payloads

### Participant fields
Each entry in `participants[]`:
- `fighters` — current count; size attack commits against this
- `destroyed: true` — a corpse; never target (attacks rejected)
- `corp_id` — opponent's corp; if it matches yours, do NOT attack (corp cohesion)

### Garrison sub-object fields
Combat events involving a garrison carry a `garrison` sub-object:
- `owner_character_id` matches your id → your garrison
- `owner_corp_id` matches your corp → your corp's garrison

### Envelope attributes
XML envelope tags identify what an event is about:
- `combat_id` — every combat event
- `garrison_id` / `garrison_owner` — garrison-subject events (e.g. `garrison.destroyed`)
- `ship_id` / `ship_name` — ship-subject events (e.g. `ship.destroyed`)

## Round Timing

- Rounds normally take 30 seconds
- After you submit your action, wait for combat update events to arrive
- If you miss the deadline, your action defaults to BRACE

## Damage, Shields, and Order

### Attack Order

- Attack order favors combatants with more fighters
- Then higher turns_per_warp
- Larger commitments swing first

### Hit Chance

- Base hit chance is roughly 50%
- Enemy shields and BRACE reduce that chance (up to 50% mitigation)
- Your own shields add a small bonus
- Final odds stay between 15% and 85%

### Fighter Losses

Each committed fighter rolls once:
- **Hit** → one enemy fighter destroyed
- **Miss** → the attacker's own fighter is destroyed

This is critical: attacking costs fighters on misses. A well-shielded target lowers your hit chance, so more of YOUR fighters die per round. Attacking a stronger ship head-on can destroy your own fleet faster than theirs.

### Shield Ablation

- Shields ablate by about half the incoming hits (less while bracing)
- Lower shields weaken mitigation in future rounds
- Shields regenerate 10 points per round

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
- `toll_satisfied` - Every hostile has paid the toll garrison
- `no_hostiles` - Only friendly combatants remain

### garrison.destroyed event

Fires when a garrison's fighters reach 0. Terminal for that garrison — any later pay/attack against its id is rejected. For your own garrison, voice narrates the loss.

## Salvage and Defeat

### When your ship is destroyed in combat
- Ship becomes an `escape_pod` (you survive, but fighter/shield/cargo/credits reset to 0)
- All cargo and ship credits drop as salvage in the sector
- Bank funds are untouched
- Escape pod gets a full warp power tank so you can move

### When you win
- Defeated opponents' cargo + credits + scrap drop as salvage in the sector
- Salvage entries carry: `cargo`, `credits`, `scrap` (ship wreckage value), `from_ship_type`, `from_ship_name`
- Collect with `salvage_collect` before another player claims it
- Salvage expires after ~15 minutes (check `expires_at`)

### Relevant events
- `salvage.created` - wreckage appeared (sector-scoped)
- `ship.destroyed` - specific ship was destroyed (subject-scoped; `ship_id`, `ship_name` on envelope)

## Strategy Tips

- **BRACE** when outnumbered, outshielded, or rebuilding shields
- **Attack** only with fighters you can afford to lose — every miss kills one of yours
- Probe with small commits to gauge hit rates before committing everything
- Against a high-shield target, small probes lose fewer fighters to misses
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
- For `target_id`, prefer the participant `id` from `combat.round_waiting.participants[]`
- Do not assume ship_id is required for attacks; use the combat participant identifier
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
    target_id="...",      # Target participant id from combat.round_waiting (for attack)
    to_sector=123,        # Escape sector (for flee)
    round_number=1        # Optional concurrency control
)
```
