# Combat in Gradient Bang

Combat is **turn-based** with 30-second rounds. Two or more participants (player ships and/or AI garrisons) engage in a sector. Each round, every participant chooses an action, then all actions resolve simultaneously.

## Fighters

Fighters are the core unit of combat. They cost **50 credits each** and are purchased at ports, limited by your ship's `max_fighters` capacity. When you attack, you **commit** a number of fighters from your pool — each committed fighter is resolved individually against the target. If your fighters hit zero, your ship is **destroyed** and you're ejected into an escape pod.

## Hit Resolution

Each committed fighter rolls against a hit probability:

- **Base hit chance:** 50%
- Defender's shields **reduce** hit chance (up to 30 percentage points)
- Attacker's shields provide a **small offensive boost** (up to 5 percentage points)
- Hit chance is clamped between **15% and 85%** — you can never guarantee a hit or a miss

On a **hit**, the target loses 1 fighter (a *defensive loss*). On a **miss**, the attacker loses 1 fighter (an *offensive loss*). Attacking is always risky.

## Shields & Mitigation

Shields serve two purposes:

1. **Mitigation** — Shields reduce the enemy's hit probability. The formula is `0.0005 * shield_points`, capped at 50%. A ship with 1000 shields gets the maximum 50% mitigation, which translates to up to a 30% reduction in enemy hit chance.

2. **Ablation** — When you take defensive losses, your shields degrade. For every 2 fighters lost, you lose ~1 shield point. Shields regenerate **10 points per round** between rounds, up to your ship's max.

## Actions

| Action | Effect |
|--------|--------|
| **Attack** | Commit N fighters against a target. Each resolves individually. |
| **Brace** | Defensive stance. Boosts your shield mitigation by 20% and reduces shield ablation by 20%. |
| **Flee** | Attempt to escape. Base 50% success, modified by relative ship speed. Clamped between 20–90%. |
| **Pay** | Garrison toll encounters only — pay the demanded amount to end hostilities. |

If you don't submit an action within 30 seconds, you automatically **brace**.

## Attrition

Attrition is the total fighter drain over the course of combat:

- **Offensive losses** — fighters you lose when your attacks miss
- **Defensive losses** — fighters you lose when enemy attacks hit you
- **Damage mitigated** — hits that *would have* landed but were deflected by shields. Tracked separately so you can see how much your shields saved you.

Your remaining fighters after a round: `fighters - offensive_losses - defensive_losses`

## Garrisons

Garrisons are AI-controlled fighter groups stationed in sectors. They have three modes:

- **Offensive** — commits up to half their fighters (min 50) aggressively
- **Defensive** — commits up to a quarter of their fighters (min 25)
- **Toll** — demands payment first, attacks if unpaid

Garrisons have **no shields** (`max_shields = 0`), making them vulnerable but dangerous in numbers. They never attack corpmates.

## Attack & Target Order

- Ships with **fewer fighters attack first** (speed tiebreaker for ties)
- Attackers prioritize targets with the **most fighters**, then most shields

## Combat Outcomes

Combat ends when a decisive state is reached: victory (all enemies eliminated), defeat, mutual defeat, successful flee, stalemate (everyone braces), or toll satisfied.

## Salvage

Destroyed ships drop salvage in the sector: all cargo, all credits, and **scrap** based on ship value (`floor(ship_price / 1000)`, minimum 5). Salvage expires after 15 minutes and can be claimed by anyone.
