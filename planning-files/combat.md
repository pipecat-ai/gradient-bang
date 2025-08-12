# Combat


# Proposed code from ChatGPT

```
import math, random
from dataclasses import dataclass

KILL_RATE = 0.02  # 2% of committed fighters per round

def shield_mitigation(shields_now: int) -> float:
    return min(0.50, 0.0005 * max(0, shields_now))

def flee_success_chance(your_tpw: int, enemy_tpw: int) -> float:
    base = 0.5 + 0.1 * (enemy_tpw - your_tpw)
    return max(0.2, min(0.9, base))

@dataclass
class Combatant:
    name: str
    fighters: int
    shields: int
    turns_per_warp: int

def resolve_combat_round(
    you: Combatant, enemy: Combatant,
    your_action: str, enemy_action: str,
    your_commit: int = 0, enemy_commit: int = 0,
    rng: random.Random = random
) -> dict:
    """
    Actions: "attack", "brace", "flee".
    - If "attack", commit > 0 and <= fighters.
    - If "brace" or "flee", commit must be 0.
    Mutates 'you' and 'enemy'; returns log dict.
    """
    log = {"events": [], "end": None}

    # Validate commits
    if your_action == "attack":
        your_commit = max(0, min(you.fighters, your_commit))
        if your_commit <= 0:
            your_action = "brace"
    else:
        your_commit = 0
    if enemy_action == "attack":
        enemy_commit = max(0, min(enemy.fighters, enemy_commit))
        if enemy_commit <= 0:
            enemy_action = "brace"
    else:
        enemy_commit = 0

    # Flee checks
    if your_action == "flee":
        p = flee_success_chance(you.turns_per_warp, enemy.turns_per_warp)
        if rng.random() < p:
            log["events"].append(f"{you.name} flees successfully.")
            log["end"] = "you_fled"
            return log
    if enemy_action == "flee":
        p = flee_success_chance(enemy.turns_per_warp, you.turns_per_warp)
        if rng.random() < p:
            log["events"].append(f"{enemy.name} flees successfully.")
            log["end"] = "enemy_fled"
            return log

    # Mitigation (with brace bonus)
    your_mit = min(0.50, shield_mitigation(you.shields)  * (1.2 if your_action  == "brace" else 1.0))
    en_mit   = min(0.50, shield_mitigation(enemy.shields) * (1.2 if enemy_action == "brace" else 1.0))

    # Potential kills (from commits)
    you_inflict_base = math.ceil(your_commit  * KILL_RATE) if your_action  == "attack" else 0
    en_inflict_base  = math.ceil(enemy_commit * KILL_RATE) if enemy_action == "attack" else 0

    # Losses suffered (apply mitigation to incoming)
    your_losses  = math.ceil(en_inflict_base * (1.0 - your_mit))
    enemy_losses = math.ceil(you_inflict_base * (1.0 - en_mit))

    # Apply fighter losses (losses come from total pool, not just committed)
    you.fighters   = max(0, you.fighters   - your_losses)
    enemy.fighters = max(0, enemy.fighters - enemy_losses)

    log["events"].append(
        f"{you.name} commits {your_commit}, loses {your_losses} (mit {int(your_mit*100)}%). "
        f"{enemy.name} commits {enemy_commit}, loses {enemy_losses} (mit {int(en_mit*100)}%)."
    )

    # Shield ablation (proportional to enemy pressure)
    your_deg  = math.ceil(en_inflict_base * 0.5)
    en_deg    = math.ceil(you_inflict_base * 0.5)
    if your_action == "brace": your_deg = math.ceil(your_deg * 0.8)
    if enemy_action == "brace": en_deg  = math.ceil(en_deg * 0.8)

    you.shields   = max(0, you.shields   - your_deg)
    enemy.shields = max(0, enemy.shields - en_deg)
    if your_deg or en_deg:
        log["events"].append(f"Shields ablate: {you.name} -{your_deg}, {enemy.name} -{en_deg}.")

    # End conditions
    if you.fighters <= 0 and enemy.fighters <= 0:
        log["end"] = "mutual_defeat"
    elif you.fighters <= 0:
        log["end"] = "you_defeated"
    elif enemy.fighters <= 0:
        log["end"] = "enemy_defeated"

    return log
```
