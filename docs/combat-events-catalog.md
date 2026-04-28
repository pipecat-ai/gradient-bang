# Combat Events Catalog

Canonical reference for every combat-related event emitted in Gradient Bang. Covers when each event fires, who receives it, its EventRelay routing rules (AppendRule + InferenceRule), its payload shape, and a realistic example.

Used as the shared baseline for the combat-parity rework: each event is tagged with its **status** so we can see at a glance what's same, what's changed, what's new, and what's production-only / harness-only.

## Legend

| Tag | Meaning |
|---|---|
| **SAME** | Identical across harness (`client/combat-sim/`) and production (`deployment/supabase/functions/` + `src/gradientbang/pipecat_server/subagents/event_relay.py`). No change needed. |
| **CHANGED** | Event exists in both but harness has additional payload fields / routing that production needs to adopt. The event `type` is unchanged; existing consumers keep working. |
| **NET NEW** | Harness emits this event; production does not. To add to production. |
| **PROD STUB** | Registered in `event_relay.py`'s EventConfig registry but never emitted by any edge function. Either wire up or delete. |
| **HARNESS-ONLY** | Debug / observability primitive. Does NOT port to production. |

## How to read an event entry

- **Fires when** — the single trigger condition. If multiple triggers, listed separately.
- **Recipients** — who the server includes in the event's recipient list (`visibility.ts` in prod; `combatRecipients()` in harness).
- **AppendRule** — where the event lands in the Python event flow. `PARTICIPANT` = combat participants; `LOCAL` = same-sector; `DIRECT` = named recipients only; `NEVER` = drop.
- **InferenceRule** — when the voice agent wakes and speaks. `ON_PARTICIPANT` = only if viewer is a participant; `ALWAYS` = every recipient; `OWNED` = only if `payload.owner_character_id == viewer.id`; `NEVER` = silent, context-only append.
- **Payload** — top-level keys only. Sub-objects noted as `garrison?: { ... }` without recursing.
- **Example** — realistic trimmed payload.

## ID convention in examples

All ID values in this doc — character_id, ship_id, corp_id, combat_id, salvage_id, garrison `internal_garrison_id` — are 6-char hex placeholders matching the `_short_id` truncation used in `status.snapshot` / `ships.list` (see [`summary_formatters.py`](../src/gradientbang/utils/summary_formatters.py)). Real IDs are full UUIDs at the wire layer; the relay shortens them when rendering to LLM context, and JSON payloads here use the same short form for readability.

The recurring placeholders below are used consistently across every example:

| Placeholder | Stands for |
|---|---|
| `a1ce0d` | Alice's character_id |
| `b0b101` | Bob's character_id |
| `ca21a3` | Carla's character_id |
| `5a1ce0` | Alice's personal ship_id |
| `5b0b10` | Bob's personal ship_id |
| `709b01` | The corp ship "Probe-1" — its ship_id |
| `c1709b` | The corp ship's pseudo-character_id (its combatant id) |
| `c0afed` | A corp_id (the "red" corp) |
| `3f2a01` | A combat_id |
| `9a7b00` | A garrison's internal DB row UUID (`internal_garrison_id`) |
| `5a1ba9` | A salvage_id |

Garrison combatant ids keep their structured form `garrison:<sector>:<owner_short_id>` (e.g. `garrison:42:b0b101`) — the sector and owner stay legible, so we don't truncate further.

---

# Combat events

## `combat.round_waiting` — **CHANGED**

**Fires when:** A new round begins — either on encounter start (just after `initiateCombat`) or immediately after the previous round resolves and combat continues.

**Recipients:** Server emits with broad recipients on every round — participants ∪ sector observers ∪ corp members of participants ∪ absent garrison owners ∪ their corp members. **The server is not round-aware.**

**AppendRule:** `PARTICIPANT` · **InferenceRule:** `ON_PARTICIPANT`

**Relay-driven round handling (CHANGED).** Rather than introducing a separate `combat.initiated` event, the bot-side relay detects `payload.round === 1` and routes this event differently:

| Round | Relay behaviour |
|---|---|
| **Round 1** | Append for **every recipient**. Direct participants and observed corp-ship/garrison stake viewers run inference; sector-only observers append silently. XML framing says "A new combat has begun…" (see round-1 examples below). |
| **Rounds 2+** | Append for direct participants and observed corp-ship/garrison stake viewers. Direct participants run inference; observed stake viewers append silently. Sector-only observers are filtered. |

Voice narration is POV-aware: observed stake viewers hear initiation and terminal resolution at normal event priority, while continuing updates stay in context without waking the bot.

**Why relay-only?** The event type, payload, and server emission stay identical every round. Only the bot-side append decision changes based on `payload.round`. This avoids a second event type, avoids a second emission path, and keeps the round-awareness in the place that already does per-viewer logic.

**Payload:**
| Key | Type | Notes |
|---|---|---|
| `combat_id` | string | Encounter id |
| `sector` | `{ id: number }` | |
| `round` | number | 1-indexed |
| `current_time` | ISO string | Server clock at emission |
| `deadline` | ISO string \| null | Null when timer disabled |
| `participants[]` | array | Per-combatant snapshot |
| `participants[].id` | string | Character id or garrison combatant id |
| `participants[].name` | string | Display name |
| `participants[].ship` | object | Ship snapshot |
| `participants[].fighters` | number | **NET field (CHANGED)** — current fighter count |
| `participants[].destroyed` | boolean | **NET field (CHANGED)** — `true` when fighters ≤ 0 |
| `participants[].corp_id` | string \| null | **NET field (CHANGED)** |
| `garrison` | object \| absent | Present when a garrison is in the encounter |
| `garrison.id` | string | `garrison:<sector>:<owner>` |
| `garrison.fighters` | number | |
| `garrison.mode` | string | `defensive \| offensive \| toll` |
| `garrison.owner_name` | string | Human name |
| `garrison.owner_character_id` | string | **NET field (CHANGED)** |
| `garrison.owner_corp_id` | string \| null | **NET field (CHANGED)** |
| `initiator` | object \| absent | Who initiated combat |

**Example:**
```json
{
  "combat_id": "3f2a01",
  "sector": { "id": 42 },
  "round": 1,
  "current_time": "2026-04-24T12:00:00Z",
  "deadline": "2026-04-24T12:00:30Z",
  "participants": [
    {
      "id": "a1ce0d",
      "name": "Alice",
      "ship": { "ship_type": "aegis_cruiser", "shield_integrity": 100 },
      "fighters": 50, "destroyed": false, "corp_id": "c0afed"
    },
    {
      "id": "garrison:42:b0b101",
      "name": "Bob's garrison",
      "ship": { "ship_type": "garrison" },
      "fighters": 30, "destroyed": false, "corp_id": null
    }
  ],
  "garrison": {
    "id": "garrison:42:b0b101",
    "fighters": 30,
    "mode": "offensive",
    "owner_name": "Bob",
    "owner_character_id": "b0b101",
    "owner_corp_id": null
  },
  "initiator": { "id": "a1ce0d", "name": "Alice" }
}
```

**XML envelope (target) — viewer-specific.** The relay runs per-viewer and can shape both envelope attrs and summary body around the viewer's *stake* in this event. Envelope attrs answer "which subject of mine is this about" — that question has a different answer per viewer.

The relay classifies each viewer into one of these POVs:

| POV | Viewer's stake | Envelope attrs |
|---|---|---|
| **DIRECT** | Viewer's personal ship is a participant | `combat_id` |
| **OBSERVED — corp ship** | Viewer's corp-mate corp-ship is a participant; viewer is remote | `combat_id`, `ship_id`, `ship_name?` (of the corp ship) |
| **OBSERVED — garrison** | Viewer owns (personally or via corp) a garrison in the fight; may be remote | `combat_id`, `garrison_id`, `garrison_owner` |
| **OBSERVED — sector only** | Viewer is in the sector but has no other stake | `combat_id` |

If a viewer has multiple stakes (e.g. DIRECT *and* garrison owner in the same fight), DIRECT wins — they're a participant, the other framings are redundant.

**Summary body shape:**
```
<pov-line> (round <N>, combat_id <id>) [deadline <ISO>]
Participants:
  - <name> (<side-marker>): combatant_id=<id>, <ship_type> "<ship_name>" [ship_id=<id>]<corp-suffix>, fighters <N>, shields <pct>%
  - <name> [opponent]: ... [DESTROYED — do NOT target; attacks will be rejected]
Garrison: <name> <side-marker> id=<garrison_id>, <N> fighters, mode=<mode>[, toll <amt>c][, owner=<name>]     ← when garrison involved
Submit a combat action now.     ← only for DIRECT
```

**POV lines differ by round + POV:**

| Round | POV | POV line |
|---|---|---|
| **1** | DIRECT | `A new combat has begun. You are a participant.` |
| **1** | OBSERVED via corp ship | `A new combat has begun. Your corp's "<ship_name>" (ship_id=<id>) has entered combat in sector <N>.` |
| **1** | OBSERVED via garrison | `A new combat has begun. Your garrison in sector <N> is under attack.` (or "corp's garrison") |
| **1** | OBSERVED sector only | `A new combat has begun in sector <N>.` |
| **2+** | DIRECT (only POV — observers are dropped) | `Combat state: you are currently in active combat.` |

See Appendix B for the side-marker cheat sheet (shared across round_waiting / round_resolved / ended).

---

### Round-1 examples (combat-start broadcast)

**DIRECT (viewer = Alice, participant):**
```xml
<event name="combat.round_waiting" combat_id="3f2a01">
A new combat has begun. You are a participant. (round 1, combat_id 3f2a01) deadline 2026-04-24T12:00:30Z
Participants:
  - Alice (you): combatant_id=a1ce0d, aegis_cruiser "Valkyrie-7" [ship_id=5a1ce0], fighters 50, shields 100%
  - Bob's garrison [opponent]: combatant_id=garrison:42:b0b101, garrison, fighters 30
Garrison: Bob [opponent] id=garrison:42:b0b101, 30 fighters, mode=offensive, owner=Bob
Submit a combat action now.
</event>
```

**OBSERVED via corp ship (viewer = Jonboy, remote; his corp's Probe-1 just entered combat):**
```xml
<event name="combat.round_waiting" combat_id="3f2a01" ship_id="709b01" ship_name="Probe-1">
Your corp's "Probe-1" (ship_id=709b01) has entered combat in sector 42. (round 1, combat_id 3f2a01)
Participants:
  - Probe-1 [ally — your corp]: combatant_id=c1709b, sparrow_scout "Probe-1" [ship_id=709b01] (corp ship), fighters 20, shields 100%
  - Alice [opponent]: combatant_id=a1ce0d, aegis_cruiser [ship_id=5a1ce0] [corp=c0afed], fighters 50, shields 100%
</event>
```

**OBSERVED via garrison — own (viewer = Bob, remote; his garrison):**
```xml
<event name="combat.round_waiting" combat_id="3f2a01" garrison_id="garrison:42:b0b101" garrison_owner="b0b101">
Your garrison in sector 42 has engaged. It is currently in offensive mode. (round 1, combat_id 3f2a01)
Participants:
  - Alice [opponent]: combatant_id=a1ce0d, aegis_cruiser [ship_id=5a1ce0] [corp=c0afed], fighters 50, shields 100%
  - Bob's garrison (yours): combatant_id=garrison:42:b0b101, garrison, fighters 30
Garrison: Bob (yours) id=garrison:42:b0b101, 30 fighters, mode=offensive, owner=Bob
</event>
```

**OBSERVED via garrison — corp-mate's (viewer = Bob, remote; garrison owned by his corp-mate Carla):**
```xml
<event name="combat.round_waiting" combat_id="3f2a01" garrison_id="garrison:42:ca21a3" garrison_owner="ca21a3">
Your corp's garrison in sector 42 has engaged. It is currently in toll mode. (round 1, combat_id 3f2a01)
Participants:
  - Alice [opponent]: combatant_id=a1ce0d, aegis_cruiser [ship_id=5a1ce0] [corp=c0afed], fighters 50, shields 100%
  - Carla's garrison [ally — your corp]: combatant_id=garrison:42:ca21a3, garrison, fighters 30
Garrison: Carla [ally — your corp] id=garrison:42:ca21a3, 30 fighters, mode=toll, toll 500c, owner=Carla
</event>
```

POV line swaps `your garrison` → `your corp's garrison`; garrison side marker shifts `(yours)` → `[ally — your corp]`; envelope `garrison_owner` resolves to Carla's id.

**DIRECT + present owner (viewer = Bob, in sector 42 alongside his own garrison when Alice arrives):**
```xml
<event name="combat.round_waiting" combat_id="3f2a01">
Combat state: you are currently in active combat. (round 1, combat_id 3f2a01) deadline 2026-04-24T12:00:30Z
Participants:
  - Bob (you): combatant_id=b0b101, freighter "Hauler-2" [ship_id=5b0b10], fighters 10, shields 100%
  - Alice [opponent]: combatant_id=a1ce0d, aegis_cruiser [ship_id=5a1ce0] [corp=c0afed], fighters 50, shields 100%
  - Bob's garrison [ally — your corp]: combatant_id=garrison:42:b0b101, garrison, fighters 30
Garrison: Bob (yours) id=garrison:42:b0b101, 30 fighters, mode=offensive, owner=Bob
Submit a combat action now.
</event>
```

Participant-self framing wins over garrison-owner framing (see [event_xml.ts:121-134](client/combat-sim/src/agent/event_xml.ts:121)). Envelope is `combat_id` only — no `garrison_id` attr needed when DIRECT; the garrison's identity is in the body.

Observer events (Bob's absent-owner case, Jonboy's corp-ship case) arrive only for round 1. Voice fires once (heads-up on combat begin), then stays silent through updates. Each can later ask "how's it going?" and the LLM answers from the participants list retained in context.

**Observer framing principles** (applied to the two examples above):
- **Neutral verb** — "has engaged" / "has entered combat", not "is under attack". A garrison encounter isn't necessarily hostile (see invariant below): the other party may pay the toll, or combat may resolve without damage.
- **Mode for garrisons** — always surface the garrison's current mode (`defensive` / `offensive` / `toll`) in the POV line so the viewer knows what rules govern this engagement.
- **Full participants list retained.** Even for observers, the participants list (with opponent ship type, fighters, shields, corp tag) stays in the body. Observers aren't narrated to proactively (InferenceRule filters them out), but they often ask follow-ups like "how strong are the opponents?" or "what ship types?" — the LLM answers those from this same context. Strip details and those questions go unanswerable.
- **Don't name the viewer.** POV line says "your garrison" / "your corp's ship", not "Bob's garrison" / "Jonboy's corp's ship". The viewer is the audience, not a subject to reference by name.

**Invariant: combat never initiates against friendly entities.** The engine's auto-engage paths filter out same-character and same-corp targets before initiating combat. Specifically, [engine.ts:498-505](client/combat-sim/src/engine/engine.ts:498) in `maybeAutoEngageOnArrival` rejects garrisons where `g.ownerCharacterId === arrivingCharId` or `g.ownerCorp === arrivingCorp`, and the mirror logic in `maybeAutoInitiateFromGarrison` does the same when a hostile character enters a sector with an offensive/toll garrison. A garrison owner will **never** receive a `combat.round_waiting` event triggered by their own (or their corp-mate's) ship arriving at the garrison's sector. The production port must preserve this invariant.

---

### Rounds 2+ example (deadline signal, participants only)

Relay drops this for non-participants. Only DIRECT recipients reach the XML step.

**DIRECT (viewer = Alice, participant, round 2):**
```xml
<event name="combat.round_waiting" combat_id="3f2a01">
Combat state: you are currently in active combat. (round 2, combat_id 3f2a01) deadline 2026-04-24T12:01:00Z
Participants:
  - Alice (you): combatant_id=a1ce0d, aegis_cruiser "Valkyrie-7" [ship_id=5a1ce0], fighters 48, shields 85%
  - Bob's garrison [opponent]: combatant_id=garrison:42:b0b101, garrison, fighters 27
Garrison: Bob [opponent] id=garrison:42:b0b101, 27 fighters, mode=offensive, owner=Bob
Submit a combat action now.
</event>
```

---

## `combat.round_resolved` — **CHANGED**

**Fires when:** A round resolves — after all submitted actions are applied (or timer expired with defaults) and damage/losses are computed.

**Recipients:** Same as `round_waiting` (incl. absent garrison owners + corp after rework).

**AppendRule:** `PARTICIPANT` · **InferenceRule:** `ALWAYS`

**Payload:** Superset of `round_waiting`. Adds per-round outcome fields.

| Key | Type | Notes |
|---|---|---|
| (all `round_waiting` keys) | | Same snapshot of participants/garrison at round end |
| `hits` | `{ [actor_id]: number }` | Number of hits scored |
| `offensive_losses` | `{ [actor_id]: number }` | Fighters lost on offense |
| `defensive_losses` | `{ [actor_id]: number }` | Fighters lost on defense |
| `shield_loss` | `{ [actor_id]: number }` | |
| `damage_mitigated` | `{ [actor_id]: number }` | |
| `fighters_remaining` | `{ [actor_id]: number }` | |
| `shields_remaining` | `{ [actor_id]: number }` | |
| `flee_results` | array | Per-flee attempt outcomes |
| `actions` | `{ [actor_id]: ActionRecord }` | What each combatant did this round |
| `result` / `end` | string \| null | Terminal state if combat ended this round |
| `deadline` | ISO string \| null | Next round's deadline, if continuing |

**Payload additions (CHANGED):** same participant field additions (`fighters`, `destroyed`, `corp_id`) + garrison owner fields (`owner_character_id`, `owner_corp_id`) as `round_waiting`.

**Example:**
```json
{
  "combat_id": "3f2a01",
  "sector": { "id": 42 },
  "round": 1,
  "hits": { "a1ce0d": 3, "garrison:42:b0b101": 2 },
  "offensive_losses": { "a1ce0d": 2 },
  "shield_loss": { "a1ce0d": 14.5 },
  "fighters_remaining": { "a1ce0d": 48, "garrison:42:b0b101": 27 },
  "shields_remaining": { "a1ce0d": 85.5 },
  "actions": {
    "a1ce0d": { "action": "attack", "target_id": "garrison:42:b0b101", "commit": 25 },
    "garrison:42:b0b101": { "action": "attack", "target_id": "a1ce0d" }
  },
  "result": null,
  "deadline": "2026-04-24T12:01:00Z"
}
```

**XML envelope (target) — viewer-specific.** Same POV-driven shape as `combat.round_waiting` (see the POV table there).

**Summary body shape:**
```
Combat state: <pov-line> (round <N>, combat_id <id>)
Round resolved: <result>; <loss line>; [garrison loss line].
Garrison: <name> <side-marker> id=<garrison_id>, <N> fighters, mode=<mode>[, owner=<name>]     ← if garrison involved
```

- **Loss line** — one fragment per stake the viewer has. DIRECT: `your: fighters lost 2, shield damage 14.5%`. OBSERVED via corp ship: `corp ship "Probe-1" (ship_id=709b01): no fighter losses, shield damage 8.2%`. OBSERVED via garrison: skip — the garrison loss line covers it.
- **Garrison loss line** (when garrison involved): `your garrison: fighters lost 3` / `corp garrison: no fighter losses` / `enemy garrison: fighters lost 5`.
- **Trailing garrison line** — full garrison snapshot, included for state visibility.

**Example — DIRECT (viewer = Alice, participant):**
```xml
<event name="combat.round_resolved" combat_id="3f2a01">
Combat state: you are currently in active combat. (round 1, combat_id 3f2a01)
Round resolved: in_progress; your: fighters lost 2, shield damage 14.5%; enemy garrison: fighters lost 3.
Garrison: Bob [opponent] id=garrison:42:b0b101, 27 fighters, mode=offensive, owner=Bob
</event>
```

**Example — OBSERVED via corp ship (viewer = Jonboy, his corp's Probe-1 is in the fight):**
```xml
<event name="combat.round_resolved" combat_id="3f2a01" ship_id="709b01" ship_name="Probe-1">
Combat state: your corp's "Probe-1" is engaged in combat. (round 1, combat_id 3f2a01)
Round resolved: in_progress; corp ship "Probe-1" (ship_id=709b01): fighters lost 1, no shield damage.
</event>
```

**Example — OBSERVED via garrison (viewer = Bob, absent garrison owner):**
```xml
<event name="combat.round_resolved" combat_id="3f2a01" garrison_id="garrison:42:b0b101" garrison_owner="b0b101">
Combat state: your garrison in sector 42 is engaged in combat. (round 1, combat_id 3f2a01)
Round resolved: in_progress; your garrison: fighters lost 3.
Garrison: Bob (yours) id=garrison:42:b0b101, 27 fighters, mode=offensive, owner=Bob
</event>
```

**Example — terminal round, `toll_satisfied` (viewer = Alice, DIRECT; she paid):**
```xml
<event name="combat.round_resolved" combat_id="3f2a01">
Combat state: you are currently in active combat. (round 1, combat_id 3f2a01)
Round resolved: toll_satisfied; your: no fighter losses, no shield damage; enemy garrison: no fighter losses.
Actions: you paid 500c toll.
Garrison: Bob [opponent] id=garrison:42:b0b101, 30 fighters, mode=toll, toll 500c, owner=Bob
</event>
```

The `result` field on the payload is the key differentiator — `toll_satisfied`, `mutual_destruction`, `one_side_destroyed`, `stalemate`, `all_fled` — and the summary body's `Round resolved:` clause surfaces it. The LLM uses it to know combat is ending.

**Example — terminal round with destruction (viewer = Alice, DIRECT; she attacked and won):**
```xml
<event name="combat.round_resolved" combat_id="3f2a01">
Combat state: you are currently in active combat. (round 3, combat_id 3f2a01)
Round resolved: one_side_destroyed; your: fighters lost 12, shield damage 45%; enemy garrison: fighters lost 30 (destroyed).
Garrison: Bob [opponent] id=garrison:42:b0b101, 0 fighters [DESTROYED], mode=offensive, owner=Bob
</event>
```

The `[DESTROYED]` marker on the garrison line tells the LLM the garrison is gone. A matching `garrison.destroyed` event fires immediately after this round_resolved with `InferenceRule.OWNED` — Bob's voice speaks even though Alice's doesn't hear it a second time (she's not the owner).

---

## `combat.ended` — **CHANGED**

**Fires when:** Combat terminates — one side destroyed, all flee successfully, toll satisfied, stalemate, or forced abort.

**Recipients:** Character participants receive personalized direct events (their own `ship` block). Corp members of participant corps and garrison stake observers (`corp_member`, `garrison_owner`, `garrison_corp_member`) receive a separate observer-safe sector event with `observed=true` and no personalized `ship` block so clients can clear observed-combat indicators without mutating personal combat state. This includes ordinary player ships in a corporation, not only autonomous corp ships.

**AppendRule:** `PARTICIPANT` · **InferenceRule:** `NEVER` *(silent append — `round_resolved` that delivered the terminal state already fired inference)*

**Payload:** Superset of `round_resolved`. Adds:

| Key | Type | Notes |
|---|---|---|
| `salvage[]` | array | Every salvage entry created this combat |
| `logs[]` | array | Round-by-round compressed history (for replay / UI) |
| `ship` | object | **Personalized participant events only** — the receiving character's own ship state at end (fighters, shields, sector, credits). Different per participant recipient. Omitted from observer-safe events. |
| `observed` | boolean | Present as `true` on observer-safe stake-observer events. |

**Payload additions (CHANGED):** same participant + garrison owner field additions as `round_waiting`.

**Example (as seen by Alice):**
```json
{
  "combat_id": "3f2a01",
  "sector": { "id": 42 },
  "round": 2,
  "result": "mutual_destruction",
  "participants": [ /* final state */ ],
  "salvage": [
    { "salvage_id": "5a1ba9", "cargo": { "quantum_foam": 10 }, "credits": 500 }
  ],
  "logs": [ /* per-round digests */ ],
  "ship": {
    "ship_id": "5a1ce0",
    "ship_type": "escape_pod",
    "fighters": 0,
    "sector": 42,
    "credits": 0
  }
}
```

**XML envelope (target) — viewer-specific.** Same POV-driven shape as `combat.round_waiting` (see the POV table there). For OBSERVED viewers, this is the moment they most need the subject id on the envelope — the summary body is brief and doesn't repeat participant lists, so without the envelope hint they'd be stuck asking "which of my ships/garrisons was that?"

**Summary body shape:**
```
<pov-line>. Result: <result>.
```

Deliberately short — `round_resolved` already carried the round-by-round detail. `combat.ended` is mostly a bookmark with the final outcome.

**POV lines:**
- DIRECT: `Your combat has ended.`
- OBSERVED via corp ship: `Your corp's "<ship_name>" (ship_id=<id>) combat in sector <N> has ended.`
- OBSERVED via garrison: `Your garrison in sector <N> (garrison_id=<id>) combat has ended.` (or "corp's garrison" for corp-mate observer)
- OBSERVED sector only: `Observed combat in sector <N> has ended.`

**Example — DIRECT (viewer = Alice, participant):**
```xml
<event name="combat.ended" combat_id="3f2a01">
Your combat has ended. Result: mutual_destruction.
</event>
```

**Example — OBSERVED via corp ship (viewer = Jonboy, his corp's Probe-1 was in the fight):**
```xml
<event name="combat.ended" combat_id="3f2a01" ship_id="709b01" ship_name="Probe-1">
Your corp's "Probe-1" (ship_id=709b01) combat in sector 42 has ended. Result: mutual_destruction.
</event>
```

**Example — OBSERVED via garrison (viewer = Bob, absent garrison owner):**
```xml
<event name="combat.ended" combat_id="3f2a01" garrison_id="garrison:42:b0b101" garrison_owner="b0b101">
Your garrison in sector 42 (garrison_id=garrison:42:b0b101) combat has ended. Result: mutual_destruction.
</event>
```

**Example — `toll_satisfied` outcome (viewer = Alice, DIRECT; she paid):**
```xml
<event name="combat.ended" combat_id="3f2a01">
Your combat has ended. Result: toll_satisfied.
</event>
```

**Example — DIRECT + present owner (viewer = Bob, present in sector 42 with his own garrison; both survived):**
```xml
<event name="combat.ended" combat_id="3f2a01">
Your combat has ended. Result: toll_satisfied.
</event>
```

Note: envelope is `combat_id` only (DIRECT POV — no garrison attr). Body is identical to any other DIRECT ended — short and outcome-focused. Bob learned the narrative from `round_resolved`; ended is the silent bookmark.

**Example — `stalemate` (viewer = Alice, DIRECT; combat ran to round limit with no decisive outcome):**
```xml
<event name="combat.ended" combat_id="3f2a01">
Your combat has ended. Result: stalemate.
</event>
```

Terminal-state variants all produce the same POV-line shape; only the `Result:` value changes. Possible values: `toll_satisfied`, `mutual_destruction`, `one_side_destroyed`, `stalemate`, `all_fled`, `surrender_accepted` (latter when surrender ships).

---

## `combat.action_accepted` — **SAME**

**Fires when:** A character successfully submits a combat action (attack / brace / flee / pay) — immediately on acceptance, before round resolution.

**Recipients:** The actor only (direct).

**AppendRule:** `PARTICIPANT` · **InferenceRule:** `NEVER` *(silent acknowledgement — no voice beat)*

**Payload:**
| Key | Type | Notes |
|---|---|---|
| `combat_id` | string | |
| `sector` | `{ id: number }` | |
| `round` | number | |
| `action` | object | `{ action, commit?, target_id?, destination_sector? }` |

**Example:**
```json
{
  "combat_id": "3f2a01",
  "sector": { "id": 42 },
  "round": 1,
  "action": { "action": "attack", "commit": 25, "target_id": "garrison:42:b0b101" }
}
```

**Notes:** Harness also includes `round_resolved: boolean` flag indicating whether the action triggered an auto-resolve (all actions in for the round). Optional; trivial diff if we choose to surface it.

**XML envelope:**
```
<event name="combat.action_accepted" combat_id="3f2a01">
Action accepted for round <N>: <action>[ commit <X>][, target <short_id>].
</event>
```

**Example — attack:**
```xml
<event name="combat.action_accepted" combat_id="3f2a01">
Action accepted for round 1: attack commit 25, target garrison:42:b0b101.
</event>
```

**Example — brace:**
```xml
<event name="combat.action_accepted" combat_id="3f2a01">
Action accepted for round 1: brace.
</event>
```

**Example — flee:**
```xml
<event name="combat.action_accepted" combat_id="3f2a01">
Action accepted for round 1: flee.
</event>
```

**Example — pay (toll):**
```xml
<event name="combat.action_accepted" combat_id="3f2a01">
Action accepted for round 1: pay, target garrison:42:b0b101.
</event>
```

Short IDs use the 6-char-prefix convention from `_short_id` in [`summary_formatters.py`](../src/gradientbang/utils/summary_formatters.py) — same form the LLM sees in `status.snapshot` and `ships.list`. Garrison combatant ids retain their structured `garrison:<sector>:<owner_short_id>` shape so the sector/owner remain legible. `commit` and `target` are only surfaced when present — `brace` has neither; `flee` has neither (destination is computed server-side); `attack` and `pay` have a target, `attack` also has a commit.

---

## `ship.destroyed` — **CHANGED**

**Fires when:** A ship's fighter count drops to 0 during round resolution.

**Recipients:** Sector occupants ∪ corp members of the destroyed ship's owner.

**AppendRule:** `LOCAL`
**InferenceRule:** `NEVER` **→ `OWNED`** *(CHANGED — voice fires for the owner after rework)*

**Payload:**
| Key | Type | Notes |
|---|---|---|
| `ship_id` | string | |
| `ship_type` | string | |
| `ship_name` | string | |
| `player_type` | `"human" \| "corporation_ship"` | |
| `player_name` | string | |
| `sector` | `{ id: number }` | |
| `combat_id` | string | |
| `salvage_created` | boolean | |
| `owner_character_id` | string | **NET field (CHANGED)** — for corp ships, pseudo-character id; for personal ships, owning human |
| `corp_id` | string \| null | **NET field (CHANGED)** |

**Example:**
```json
{
  "ship_id": "5a1ce0",
  "ship_type": "aegis_cruiser",
  "ship_name": "The Enforcer",
  "player_type": "human",
  "player_name": "Alice",
  "sector": { "id": 42 },
  "combat_id": "3f2a01",
  "salvage_created": true,
  "owner_character_id": "a1ce0d",
  "corp_id": "c0afed"
}
```

**Voice beat after rework:** Owner hears "Commander, the Enforcer has been destroyed." Matching corp members also hear when a corp ship is destroyed. Unrelated non-local recipients get RTVI only.

**XML envelope (target) — subject-scoped.** The event's subject is always one specific ship, so `ship_id` + `ship_name?` ride the envelope regardless of viewer POV. Only the summary body framing changes per viewer.

```
<event name="ship.destroyed" combat_id="<id>" ship_id="<id>" ship_name="<name>">
<summary body>
</event>
```

| Envelope attr | When present | Source |
|---|---|---|
| `combat_id` | when destruction is in combat | payload.combat_id |
| `ship_id` | always | payload.ship_id |
| `ship_name` | when present | payload.ship_name |

**Summary body** (POV-aware):

**Example — DIRECT (viewer = Alice, owner; voice narrates after rework):**
```xml
<event name="ship.destroyed" combat_id="3f2a01" ship_id="5a1ce0" ship_name="The Enforcer">
Your ship "The Enforcer" (aegis_cruiser) ship_id=5a1ce0 was destroyed in sector 42.
</event>
```

**Example — OBSERVED via corp (viewer = Jonboy, corp-mate of the pilot):**
```xml
<event name="ship.destroyed" combat_id="3f2a01" ship_id="709b01" ship_name="Probe-1">
Your corp's ship "Probe-1" (sparrow_scout) ship_id=709b01 in sector 42 was destroyed (pilot: Probe-1, corporation_ship).
</event>
```

**Example — OBSERVED sector only (viewer = random observer in sector 42):**
```xml
<event name="ship.destroyed" combat_id="3f2a01" ship_id="5a1ce0" ship_name="The Enforcer">
Ship destroyed: "The Enforcer" (aegis_cruiser) ship_id=5a1ce0 in sector 42 (pilot: Alice, human).
</event>
```

**Subject axis: the destroyed ship may be a *personal ship* (human pilot) or a *corp ship* (pseudo-character pilot).** Body framing differs by the `player_type` field.

**Example — OBSERVED via corp, *corp ship* destroyed (viewer = Jonboy, in corp-blue; his corp's autonomous Probe-1 fell):**
```xml
<event name="ship.destroyed" combat_id="3f2a01" ship_id="709b01" ship_name="Probe-1">
Your corp's ship "Probe-1" (sparrow_scout) ship_id=709b01 in sector 42 was destroyed (pilot: Probe-1, corporation_ship).
</event>
```

**Example — OBSERVED via corp, *personal ship* of corp-mate destroyed (viewer = Jonboy, in corp-red; his corp-mate Alice's personal ship fell):**
```xml
<event name="ship.destroyed" combat_id="3f2a01" ship_id="5a1ce0" ship_name="The Enforcer">
Your corp's ship "The Enforcer" (aegis_cruiser) ship_id=5a1ce0 in sector 42 was destroyed (pilot: Alice, human).
</event>
```

Body difference from the corp-ship case: `pilot: Alice, human` vs `pilot: Probe-1, corporation_ship`. Helps the LLM distinguish "we lost an autonomous hauler" from "a corp-mate died in their ship."

**Example — OBSERVED sector only, *corp ship* destroyed (viewer = Dan, in sector 42 but not in Probe-1's corp):**
```xml
<event name="ship.destroyed" combat_id="3f2a01" ship_id="709b01" ship_name="Probe-1">
Ship destroyed: "Probe-1" (sparrow_scout) ship_id=709b01 in sector 42 (pilot: Probe-1, corporation_ship).
</event>
```

Dan sees the corp-ship fall as a generic observer — the `Your corp's ship` framing doesn't apply because the corp doesn't match his.

**Recipients reminder.** Sector occupants + corp members of the destroyed ship's corp. A player not in the sector and not in the ship's corp receives no `ship.destroyed` event — no XML is generated for them at all.

---

## `salvage.created` — **SAME**

**Fires when:** A destroyed ship leaves salvage (cargo + scrap + credits > 0).

**Recipients:** Sector occupants.

**AppendRule:** `LOCAL` · **InferenceRule:** `NEVER`

**Payload:**
| Key | Type | Notes |
|---|---|---|
| `salvage_id` | string | |
| `sector` | `{ id: number }` | |
| `cargo` | `{ quantum_foam?, retro_organics?, neuro_symbolics? }` | |
| `scrap` | `{ ... }` | By ship-component |
| `credits` | number | |
| `from_ship_type` | string | |
| `from_ship_name` | string | |
| `timestamp` | ISO string | |
| `combat_id` | string | |

**Example:**
```json
{
  "salvage_id": "5a1ba9",
  "sector": { "id": 42 },
  "cargo": { "quantum_foam": 50 },
  "scrap": {},
  "credits": 250,
  "from_ship_type": "wayfarer_freighter",
  "from_ship_name": "Hauler One",
  "timestamp": "2026-04-24T12:00:45Z",
  "combat_id": "3f2a01"
}
```

**XML envelope:** Not appended to LLM context today (AppendRule `LOCAL` + no inference). Production sends the payload through RTVI to the web client for UI updates only. No summary body / envelope is generated.

If we decide to surface it to the LLM later (e.g. so the agent can comment on wreckage), the harness's structure would apply — a single-line summary wrapped in `<event name="salvage.created" combat_id="…">`.

---

## `garrison.destroyed` — **NET NEW** (in production)

**Fires when:** A garrison's fighter count drops to 0 during round resolution. Emitted *before* the garrison row is deleted so metadata is captured.

**Recipients:** Garrison owner ∪ owner's corp members ∪ sector observers (whether owner is present or absent).

**AppendRule:** `PARTICIPANT` · **InferenceRule:** `OWNED` *(NET — requires `InferenceRule.OWNED` framework add)*

**Payload:**
| Key | Type | Notes |
|---|---|---|
| `combat_id` | string | |
| `combatant_id` | string | Same as `garrison_id` — kept for consumers matching on participant ids |
| `garrison_id` | string | Stable combatant form `garrison:<sector>:<owner>` |
| `internal_garrison_id` | string | DB row UUID (for server-side reconciliation) |
| `owner_character_id` | string | |
| `owner_corp_id` | string \| null | |
| `owner_name` | string | |
| `sector` | `{ id: number }` | |
| `mode` | `"defensive" \| "offensive" \| "toll"` | |

**Example:**
```json
{
  "combat_id": "3f2a01",
  "combatant_id": "garrison:42:b0b101",
  "garrison_id": "garrison:42:b0b101",
  "internal_garrison_id": "9a7b00",
  "owner_character_id": "b0b101",
  "owner_corp_id": null,
  "owner_name": "Bob",
  "sector": { "id": 42 },
  "mode": "offensive"
}
```

**Voice beat:** Owner hears "Commander, your garrison in sector 42 has fallen." Corp members may get silent context; sector-only observers get RTVI only.

**XML envelope (target) — subject-scoped.** Like `ship.destroyed`, the subject is always one specific garrison; `garrison_id` + `garrison_owner` ride the envelope regardless of viewer POV.

```
<event name="garrison.destroyed" combat_id="<id>" garrison_id="<id>" garrison_owner="<owner_char_id>">
<summary body>
</event>
```

| Envelope attr | When present | Source |
|---|---|---|
| `combat_id` | always | payload.combat_id |
| `garrison_id` | always | payload.garrison_id |
| `garrison_owner` | always | payload.owner_character_id |

**Summary body** (POV-aware):

**Example — DIRECT (viewer = Bob, owner; voice narrates):**
```xml
<event name="garrison.destroyed" combat_id="3f2a01" garrison_id="garrison:42:b0b101" garrison_owner="b0b101">
Your garrison was destroyed in sector 42 garrison_id=garrison:42:b0b101, mode=offensive.
</event>
```

**Example — OBSERVED via corp (viewer = Carla, Bob's corp-mate):**
```xml
<event name="garrison.destroyed" combat_id="3f2a01" garrison_id="garrison:42:b0b101" garrison_owner="b0b101">
Your corp's garrison (owner Bob) was destroyed in sector 42 garrison_id=garrison:42:b0b101, mode=offensive.
</event>
```

**Example — OBSERVED sector only (viewer = random observer in sector 42):**
```xml
<event name="garrison.destroyed" combat_id="3f2a01" garrison_id="garrison:42:b0b101" garrison_owner="b0b101">
Garrison destroyed in sector 42 garrison_id=garrison:42:b0b101, mode=offensive (owner: Bob).
</event>
```

**Mode axis: `defensive` / `offensive` / `toll`.** Body surfaces the mode so the viewer knows *what kind of asset* they just lost. Implementation-wise, same POV branching as above; only the `mode=` token changes.

**Example — DIRECT, toll garrison destroyed (viewer = Bob; his toll-collecting garrison was overwhelmed):**
```xml
<event name="garrison.destroyed" combat_id="3f2a01" garrison_id="garrison:42:b0b101" garrison_owner="b0b101">
Your garrison was destroyed in sector 42 garrison_id=garrison:42:b0b101, mode=toll.
</event>
```

**Example — DIRECT, defensive garrison destroyed (viewer = Bob; his defensive garrison fell holding the sector):**
```xml
<event name="garrison.destroyed" combat_id="3f2a01" garrison_id="garrison:42:b0b101" garrison_owner="b0b101">
Your garrison was destroyed in sector 42 garrison_id=garrison:42:b0b101, mode=defensive.
</event>
```

**Example — OBSERVED via corp, toll garrison destroyed (viewer = Carla; her corp-mate Bob lost a toll garrison):**
```xml
<event name="garrison.destroyed" combat_id="3f2a01" garrison_id="garrison:42:b0b101" garrison_owner="b0b101">
Your corp's garrison (owner Bob) was destroyed in sector 42 garrison_id=garrison:42:b0b101, mode=toll.
</event>
```

**Voice beat varies by POV + mode:**
- DIRECT owner: *"Commander, your toll garrison in sector 42 has fallen."* — mode surfaces so the commander knows which type of asset was lost (they may have several garrisons in different modes).
- OBSERVED via corp: silent append.
- OBSERVED sector only: silent append.

**Recipients reminder.** Garrison owner + owner's corp members + sector occupants. Players with no stake receive no event — no XML generated for them.

---

## `garrison.deployed` — **PROD STUB** *(verify)*

**Fires when:** A character deploys a garrison. Emitted by the harness when `deployGarrison()` runs. In production, registered in `event_relay.py` but the edge function's emission wiring needs verification.

**Recipients (harness):** Owner + the new garrison id.

**AppendRule:** `DIRECT` (default) · **InferenceRule:** `NEVER` (default)

**Payload:**
| Key | Type | Notes |
|---|---|---|
| `garrison_id` | string | |
| `owner_character_id` | string | |
| `owner_name` | string | |
| `sector` | number | |
| `fighters` | number | |
| `mode` | string | |
| `toll_amount` | number | |

**Example:**
```json
{
  "garrison_id": "garrison:42:b0b101",
  "owner_character_id": "b0b101",
  "owner_name": "Bob",
  "sector": 42,
  "fighters": 30,
  "mode": "offensive",
  "toll_amount": 0
}
```

**Action:** Confirm prod emission in `garrison_deploy/index.ts` (or wherever deploys happen). If not wired, either ship emission or drop the EventConfig registration.

---

## `garrison.mode_changed` — **PROD STUB**

**Fires when:** Would fire when garrison mode switches (`defensive ↔ offensive ↔ toll`). Registered in production `event_relay.py` but never emitted anywhere in the edge-function code.

**Status:** No harness equivalent. Decide: wire up emission when `combat_set_garrison_mode` is called, or remove the stale registration.

**Proposed payload (if wired):**
```json
{
  "garrison_id": "garrison:42:b0b101",
  "owner_character_id": "b0b101",
  "sector": { "id": 42 },
  "previous_mode": "defensive",
  "new_mode": "toll",
  "toll_amount": 500
}
```

---

## `garrison.collected` — **PROD STUB**

**Fires when:** Would fire when a garrison is withdrawn / collected by its owner. Registered in `event_relay.py`; never emitted.

**Status:** Stub. Decide: wire or remove.

---

## `salvage.collected` — **PROD STUB**

**Fires when:** Would fire when salvage is claimed by a player. Registered in `event_relay.py`; never emitted.

**Status:** Stub. The intent is presumably today's `salvage.claimed` semantic. Decide: wire or remove.

---

# Harness-only debug events

**These do not port to production.** Listed for completeness so readers know why they exist in the harness and why they're excluded.

## `world.reset` — **HARNESS-ONLY**

**Fires when:** The harness user clicks "Reset world" or re-randomizes the scenario. Signals every subscriber to drop cached state (agents, traces, UI selections).

**Payload:** `{}` · **Recipients:** `[]` (broadcast via emitter subscription, not routed).

## `harness.timer_toggled` — **HARNESS-ONLY**

**Fires when:** User toggles the round-timer on/off in the harness header.

**Payload:** `{ enabled: boolean }` · **Recipients:** `[]`.

---

# Summary matrix

| Event | Status | AppendRule | InferenceRule | Key payload additions from rework |
|---|---|---|---|---|
| `combat.round_waiting` | CHANGED | PARTICIPANT | ON_PARTICIPANT | participant `fighters`/`destroyed`/`corp_id`; garrison `owner_character_id`/`owner_corp_id`; **relay-driven round-1 fan-out** (round 1 appends for all recipients with "combat has begun" framing; rounds 2+ drop for non-participants) |
| `combat.round_resolved` | CHANGED | PARTICIPANT | ALWAYS | (same payload additions as above); widened recipients to include absent garrison owners + their corp |
| `combat.ended` | CHANGED | PARTICIPANT | NEVER | participant-personalized direct event plus observer-safe stake-observer event (`observed=true`, no `ship`) |
| `combat.action_accepted` | SAME | PARTICIPANT | NEVER | — |
| `ship.destroyed` | CHANGED | LOCAL | NEVER → **OWNED** | `owner_character_id`, `corp_id` |
| `salvage.created` | SAME | LOCAL | NEVER | — |
| `garrison.destroyed` | **NET NEW** | PARTICIPANT | **OWNED** | entire event |
| `garrison.deployed` | PROD STUB | DIRECT | NEVER | verify prod emission |
| `garrison.mode_changed` | PROD STUB | DIRECT | NEVER | decide: wire or remove |
| `garrison.collected` | PROD STUB | DIRECT | NEVER | decide: wire or remove |
| `salvage.collected` | PROD STUB | DIRECT | NEVER | decide: wire or remove |
| `world.reset` | HARNESS-ONLY | NEVER | NEVER | excluded |
| `harness.timer_toggled` | HARNESS-ONLY | NEVER | NEVER | excluded |

---

# Appendix A — Envelope XML attrs at a glance

Quick cross-reference. Full per-event XML structure + examples live in each event's section above.

Envelope attrs identify *the viewer's stake* in this event. For encounter-scoped events (round events + `combat.ended`), the attrs are **viewer-specific** — the relay picks them based on whether the viewer is DIRECT or OBSERVED (and what they're observing via). For subject-scoped events (`ship.destroyed`, `garrison.destroyed`), the subject id rides the envelope regardless of viewer.

| Event | Today's envelope attrs | Target envelope attrs (per viewer) | Status |
|---|---|---|---|
| `combat.round_waiting` | `combat_id` | **DIRECT:** `combat_id` · **OBSERVED via corp ship:** `+ship_id, ship_name?` · **OBSERVED via garrison:** `+garrison_id, garrison_owner` | CHANGED |
| `combat.round_resolved` | `combat_id` | same as round_waiting | CHANGED |
| `combat.ended` | `combat_id` | same as round_waiting | CHANGED |
| `combat.action_accepted` | `combat_id` | `combat_id` (actor only) | SAME |
| `ship.destroyed` | `combat_id` | `combat_id, ship_id, ship_name?` (always) | CHANGED |
| `salvage.created` | (not appended) | (not appended) | SAME |
| `garrison.destroyed` | (event doesn't exist) | `combat_id, garrison_id, garrison_owner` (always) | NET NEW |

`?` = conditional on payload field being present.

# Appendix B — Summary body structure (cheat sheet)

Every combat-event summary body rendered by the event relay starts with a **POV line** (`Combat state: ...`) that frames the event for the viewer:

| POV | Phrasing |
|---|---|
| Participant | `you are currently in active combat.` |
| Corp-mate of participant | `your corp's "<ship_name>" is engaged in combat.` |
| Absent garrison owner | `your garrison in sector <N> is engaged in combat.` |
| Corp-mate of absent garrison owner | `your corp's garrison in sector <N> is engaged in combat.` |
| Sector observer / other | `this combat event is not your fight.` |

The POV line is deterministic from `payload.participants[].corp_id` + `payload.garrison.owner_character_id` + `payload.garrison.owner_corp_id` matched against the viewer's `(character_id, corp_id)`. No extra server round-trips.

**Side markers** applied to each participant + garrison line:
- `(you)` — self
- `[ally — your corp]` — corp-mate
- `[opponent]` — everyone else
- `(yours)` — your garrison (on the garrison line specifically)
- `[DESTROYED — do NOT target; attacks will be rejected]` — appended when `destroyed: true`

---

# Source references

- Harness EventConfig registry: [`client/combat-sim/src/relay/event_relay.ts`](../client/combat-sim/src/relay/event_relay.ts)
- Harness engine emissions: [`client/combat-sim/src/engine/engine.ts`](../client/combat-sim/src/engine/engine.ts), [`client/combat-sim/src/engine/events.ts`](../client/combat-sim/src/engine/events.ts)
- Harness event shape: [`client/combat-sim/src/engine/types.ts`](../client/combat-sim/src/engine/types.ts)
- Production EventConfig registry: [`src/gradientbang/pipecat_server/subagents/event_relay.py`](../src/gradientbang/pipecat_server/subagents/event_relay.py)
- Production payload builders: [`deployment/supabase/functions/_shared/combat_events.ts`](../deployment/supabase/functions/_shared/combat_events.ts)
- Production combat terminal events: [`deployment/supabase/functions/_shared/combat_finalization.ts`](../deployment/supabase/functions/_shared/combat_finalization.ts)
- Production round resolution: [`deployment/supabase/functions/_shared/combat_resolution.ts`](../deployment/supabase/functions/_shared/combat_resolution.ts)
- Production recipient scoping: [`deployment/supabase/functions/_shared/visibility.ts`](../deployment/supabase/functions/_shared/visibility.ts)
- Related planning: [combat-event-parity-spec.md](combat-event-parity-spec.md), [combat-migration-phase-plan.md](combat-migration-phase-plan.md)
