# Production Combat Event Parity Migration — Implementation Spec

## Context

The combat-sim harness (`client/combat-sim/`) has evolved a set of event-shape and routing improvements that materially improve combat agent behavior and player observability — cleaner garrison lifecycle signals, richer participant metadata, absent-owner visibility, and framework additions like `InferenceRule.OWNED`. The production combat flow — emission (Supabase edge functions), routing (Python `EventRelay`), and consumption (game client + RTVI) — lags behind.

This spec enumerates the **event-layer** discrepancies and plans surgical, additive changes to bring production to parity. It is the event-layer counterpart to the engine migration described in [combat-debug-harness-spec.md](combat-debug-harness-spec.md).

### In scope
- Event emission (edge functions)
- Event payload shape and metadata
- Event recipient/routing rules (`visibility.ts` + `event_relay.py`)
- XML envelope attributes (LLM context)
- RTVI pass-through (implicit — RTVI is a transparent passthrough of payload; shape changes flow automatically)

### Out of scope
- UI / client rendering work (tracked separately)
- Strategies spec ([combat-strategies-spec.md](combat-strategies-spec.md))
- Engine swap itself (harness engine → `_shared/combat/*`)
- `world.reset`, `harness.timer_toggled`, `forceEndCombat` — harness-only debug primitives

### Adjacent engine fixes (bundled)
A small set of engine-behavior fixes surfaced during harness work. They're not event-shape changes, but they're close enough to the event surface (toll state lives in event payloads) that bundling them with the event migration is cleaner than splitting. See "Adjacent engine fixes" below for detail.

### Non-breaking contract
All changes here are **additive**: new events, new payload fields, new XML attributes, new recipient logic. No renames, no removals, no field-shape changes. Existing consumers (web client, older bots, anything reading `events` rows) continue to work unchanged. This keeps each surface independently shippable.

---

## Key discrepancies

Each row is an independent, surgical change. "Surface" maps to the detailed sections below.

| # | Discrepancy | Current prod | Target (harness parity) | Type | Risk | Surface |
|---|---|---|---|---|---|---|
| 1 | `garrison.destroyed` event | not emitted (silent `.delete()` in `updateGarrisonState`) | emitted before row delete with full garrison metadata | **new event** | low | A |
| 2 | Absent garrison owner receives combat events | no (only participants + sector + corp) | yes — silent append on round events, voice-announce on `garrison.destroyed` | **routing** | med | B |
| 3 | `InferenceRule.OWNED` category | absent from `event_relay.py` | added; fires LLM only for owning character | **framework** | low | C |
| 4 | Garrison envelope XML attrs | `combat_id` only | + `garrison_id="<combatant_id>"`, `garrison_owner="<character_id>"` on every garrison-involved combat event | **envelope** | low | D |
| 5 | Participant `fighters` field | missing | included — current fighter count per combatant | **payload** | low | E |
| 6 | Participant `destroyed` flag | missing | included — `true` when `fighters ≤ 0` | **payload** | low | E |
| 7 | Participant `corp_id` field | missing | included — corp affiliation per combatant | **payload** | med (privacy) | E |
| 8 | Garrison `owner_character_id` in payload | missing (only `owner_name` human string) | included | **payload** | med (privacy) | F |
| 9 | Garrison `owner_corp_id` in payload | missing | included | **payload** | med (privacy) | F |
| 10 | `ship.destroyed` `owner_character_id` | missing | included | **payload** | med (privacy) | G |
| 11 | `ship.destroyed` `corp_id` | missing | included | **payload** | med (privacy) | G |

**Privacy note (rows 7–11):** Exposing character IDs and corp IDs in broadcast event payloads means any recipient of a combat event can see who owns what. This is acceptable because combat event recipients are already scoped by `visibility.ts` to people who have a legitimate stake (participant, sector observer, corp member, garrison owner). None of these are random third parties. But we should scrub before deploy and confirm no recipient class gets a combatant's owner ID they shouldn't. Worst case: opt into per-recipient redaction for some fields (e.g. mask `corp_id` when recipient is a sector-only observer not in that corp). MVP: add without redaction, revisit if it leaks.

---

## Recipient impact

Companion view to the discrepancy table — shows *who* starts receiving what after each change lands. Recipient sets are unioned and deduped across classes: a character in multiple classes (e.g. owns the garrison AND is in the sector) still only receives the event once.

### Recipient classes

| Code | Class | Includes |
|---|---|---|
| **P** | Participant | Character whose personal ship is in the fight; character piloting a corp ship in the fight; corp-ship pseudo-character (autonomous); present garrison owner |
| **S** | Sector observer | Character in the combat sector but not a combatant |
| **CP** | Corp member of participant | Character in the corp of any participant, but not in the sector / not in the fight |
| **GO** | Absent garrison owner | Character who deployed a garrison that's in the combat, but is NOT in the sector |
| **CGO** | Corp member of absent owner | Character in the corp of an absent garrison owner, not in the sector |

### Delivery per discrepancy

| # | Discrepancy | Carried by | Today's recipients | +New after migration | Voice narration fires for |
|---|---|---|---|---|---|
| 1 | `garrison.destroyed` (new event) | itself | **nobody** (event doesn't exist) | P + S + CP + **GO** + **CGO** | **GO only** (via `InferenceRule.OWNED`) |
| 2 | Absent-owner routing | `round_waiting` / `round_resolved` / `ended` | P + S + CP | + **GO** + **CGO** (silent append) | no change — `ON_PARTICIPANT` already filters non-participants |
| 3 | `InferenceRule.OWNED` (framework) | — | — | — | enables per-owner firing (used by #1; candidate for `ship.destroyed` later) |
| 4 | Garrison envelope XML attrs | round events + `garrison.destroyed` | same as events | (no recipient change) | no change |
| 5 | Participant `fighters` | round events | P + S + CP | (no recipient change) | no change |
| 6 | Participant `destroyed` flag | round events | P + S + CP | (no recipient change) | no change |
| 7 | Participant `corp_id` | round events | P + S + CP | (no recipient change) | no change |
| 8 | Garrison `owner_character_id` | round events | P + S + CP | (no recipient change) | no change |
| 9 | Garrison `owner_corp_id` | round events | P + S + CP | (no recipient change) | no change |
| 10 | `ship.destroyed` `owner_character_id` | `ship.destroyed` | S + corp-of-destroyed-ship | (no recipient change) | no change (NEVER inference) |
| 11 | `ship.destroyed` `corp_id` | `ship.destroyed` | S + corp-of-destroyed-ship | (no recipient change) | no change (NEVER inference) |

**Scope takeaway.** Only **two rows change who gets events**: #1 (new event, all five classes receive it) and #2 (widens combat-round-event recipients to include GO + CGO). Rows 3–11 either enrich payloads that already reach the same people, or add framework scaffolding. The migration expands information for garrison owners and their corps; it does not widen visibility for any other class.

---

## Migration surfaces

Each surface is a self-contained change. Dependencies called out inline.

### Surface A — `garrison.destroyed` event (fixes #1)

**What.** Add a new event type emitted when a garrison's fighters reach 0 and the row is about to be deleted. Today [combat_finalization.ts:248-279](../deployment/supabase/functions/_shared/combat_finalization.ts) silently `.delete()`s the row. Downstream has to infer destruction from `fighters_remaining[garrison_id] = 0` inside `combat.round_resolved` — fragile and invisible to the voice agent.

**Payload shape** (copy from harness [engine.ts:1294](../client/combat-sim/src/engine/engine.ts)):
```json
{
  "source": { "type": "rpc", "method": "combat.round_resolved", "request_id": "...", "timestamp": "..." },
  "combat_id": "<combat_id>",
  "combatant_id": "garrison:<sector>:<owner_character_id>",
  "garrison_id": "garrison:<sector>:<owner_character_id>",
  "internal_garrison_id": "<row UUID>",
  "owner_character_id": "<character_id>",
  "owner_corp_id": "<corp_id> | null",
  "owner_name": "Captain Vega",
  "sector": { "id": 42 },
  "mode": "defensive | offensive | toll"
}
```

Rationale for the three ID fields:
- `garrison_id` / `combatant_id` — stable combatant form (`garrison:<sector>:<owner>`), matches the `id` used in the `garrison` sub-object of combat events. This is what the LLM and consumers match on.
- `internal_garrison_id` — the world-map UUID (for row-level lookups / reconciliation). Only useful to programmatic consumers; LLM doesn't need it.

**Emission site.** `combat_finalization.ts` in `updateGarrisonState()` — emit **before** the `.delete()` call. Capture the garrison row's full metadata while it still exists.

**Routing.** `AppendRule.PARTICIPANT` + `InferenceRule.OWNED`. OWNED is a new rule category (see Surface C). The owner's voice agent speaks ("Commander, the garrison in sector 42 has fallen."); sector observers and corp members get silent context append.

**Server-side recipient expansion.** The `garrison.destroyed` event's recipient list at emission time must include: `[owner_character_id, ...owner_corp_member_ids, ...sector_observers]`. Add a helper to `_shared/visibility.ts` (e.g. `garrisonDestroyedRecipients(garrison, sectorOccupants)`) if one doesn't already exist for this shape.

**Framework registration.** Add `"garrison.destroyed"` to the event type set in [event_identity.ts](../deployment/supabase/functions/_shared/event_identity.ts).

**Bot-side registration.** Add an `EventConfig` in [event_relay.py](../src/gradientbang/pipecat_server/subagents/event_relay.py):
```python
"garrison.destroyed": EventConfig(
  append_rule=AppendRule.PARTICIPANT,
  inference_rule=InferenceRule.OWNED,   # new, see Surface C
  priority=EventPriority.HIGH,
  xml_context_key="combat_id",
  voice_summary=_summarize_garrison_destroyed,
),
```

Plus `_summarize_garrison_destroyed()` returning: `"Your garrison in sector {N} has fallen."` (owner) or `"A garrison in sector {N} has been destroyed."` (others).

**Client-side.** Add a `garrison.destroyed` handler in [GameContext.tsx](../client/app/src/GameContext.tsx) to remove the garrison marker and optionally show a toast. Should already be prepared to receive the event once the server emits it (RTVI is a transparent passthrough).

**Tests.** Port the harness's `agent.test.ts > remote garrison event flow` scenarios to `deployment/supabase/functions/tests/combat_test.ts`. Specifically:
- Owner in different sector: receives event, payload matches shape
- Owner's corpmate in different sector: receives event
- Random third party: does NOT receive event
- Owner in the combat sector: receives event once (no double-delivery)

---

### Surface B — Absent garrison owner event routing (fixes #2)

**What.** When a garrison is in combat but its owner is elsewhere, the owner today sees nothing in-game. The harness routes `combat.round_waiting / round_resolved / ended` to the absent owner with silent append (voice agent doesn't speak) so the player's context stays up to date and they can ask "how's my garrison in sector 42?" and get a real answer.

**Key insight.** Silencing the voice agent for absent owners is already done for free by the existing `InferenceRule.ON_PARTICIPANT` — absent garrison owners are NOT participants, so ON_PARTICIPANT doesn't fire inference for them. The *only* change needed is expanding the recipient set so they receive the event in the first place.

**Emission-layer change.** Modify the recipient computation in [`_shared/visibility.ts`](../deployment/supabase/functions/_shared/visibility.ts) (and whatever helpers `combat_events.ts` / `combat_resolution.ts` use) to include garrison owners + owner-corp members when a garrison is in the encounter. Harness reference: `combatRecipients()` in `client/combat-sim/src/engine/engine.ts`.

Concretely: for any combat event where the encounter has at least one garrison, the recipient list becomes:
```
participants ∪ sector_observers ∪ participant_corp_members
  ∪ garrison_owners ∪ garrison_owner_corp_members
```

Deduped. Only garrisons actually in the `encounter.participants` set (not sector drift-bys).

**No EventRelay change needed for silencing.** ON_PARTICIPANT on `round_waiting` already skips LLM inference for non-participants. The absent garrison owner gets silent append — exactly what we want.

**Coupling to Surface A.** `garrison.destroyed` (Surface A) uses InferenceRule.OWNED, which *does* fire inference for the owner. So the owner gets silent background updates + one voice-announced death moment. That's the designed UX.

**Tests.** The four harness scenarios in `agent.test.ts > remote garrison event flow` cover this:
1. Remote owner receives round events (silent append)
2. Corp mate of remote owner receives round events (silent append)
3. Destruction: owner's voice speaks
4. Uninvolved third party receives nothing

Mirror all four in `combat_test.ts`.

**Risk.** Medium — changes who gets which events. Rollback story: one small diff to revert in `visibility.ts`.

---

### Surface C — `InferenceRule.OWNED` rule category (fixes #3)

**What.** Add a new `InferenceRule` enum member to [event_relay.py](../src/gradientbang/pipecat_server/subagents/event_relay.py) that fires LLM inference **only** for the player whose `owner_character_id` matches `payload.owner_character_id` (or equivalent). Non-owners still append silently.

**Used by.** `garrison.destroyed` (Surface A). Candidate for future events: `ship.destroyed` for your own ship, etc. — out of scope here.

**Implementation.** In `event_relay.py`, extend `InferenceRule` enum and add a branch in `_should_run_llm()` that checks `payload.get("owner_character_id") == player.id`. Keep it simple — single field check, no fallback.

**Risk.** Low — new enum value, purely additive.

---

### Surface D — Garrison envelope XML attributes (fixes #4)

**What.** Today combat events render to the LLM as:
```xml
<event name="combat.round_waiting" combat_id="abc-123">
Combat state: ...
</event>
```

When a garrison is in the combat, UI/filter/agent code has to parse the summary body to know which garrison. The harness adds structured discriminators on the envelope:
```xml
<event name="combat.round_waiting" combat_id="abc-123" garrison_id="garrison:42:char-9" garrison_owner="char-9">
Combat state: ...
</event>
```

And on `garrison.destroyed`:
```xml
<event name="garrison.destroyed" combat_id="abc-123" garrison_id="garrison:42:char-9" garrison_owner="char-9">
Your garrison in sector 42 has fallen.
</event>
```

**Implementation.** Extend the XML builder in `event_relay.py` (around the existing `xml_context_key` logic ~line 1176) to support a *list* of context attributes, not just one. Then set:
- `combat.round_waiting / round_resolved / ended`: base attrs `[combat_id]`; if `payload.garrison` present, append `garrison_id` (from `payload.garrison.id`) and `garrison_owner` (from `payload.garrison.owner_character_id` — which Surface F adds)
- `garrison.destroyed`: attrs `[combat_id, garrison_id, garrison_owner]`

**Data dependency.** `garrison_owner` reads from `owner_character_id` — added by Surface F. So D depends on F for the garrison fields, and on A for the `garrison.destroyed` event. Ship A + F + C together, then add D as a follow-up that enriches existing events without breaking anything.

**Risk.** Low — XML attrs only. LLM parses whatever is there; adding attrs can't break anything. Envelopes stay valid XML.

---

### Surface E — Combat event participant metadata additions (fixes #5, #6, #7)

**What.** Add three fields to every participant object inside `combat.round_waiting`, `combat.round_resolved`, and `combat.ended` payloads:
- `fighters: number` — current fighter count (eliminates `fighters_remaining[id]` lookup needed to answer "who's alive?")
- `destroyed: boolean` — `true` when `fighters ≤ 0` (convenience over `fighters` comparison; doubles as LLM hint that this target is a corpse)
- `corp_id: string | null` — corp affiliation (enables corp-mate framing in LLM prompts)

**Why all three.**
- `fighters` alone lets you compute `destroyed`, but shipping both eliminates a class of off-by-one agent bugs ("is `fighters: 0` the same as destroyed?"). Harness pays the cost, so does prod.
- `corp_id` surfaces the corp relationship cleanly. The agent can reason "X is my corpmate, don't attack" without cross-referencing a corp-members map.

**Implementation.** Extend `buildParticipant` / equivalent in [combat_events.ts](../deployment/supabase/functions/_shared/combat_events.ts). Pull `fighters` from `encounter.participants[id].fighters`; compute `destroyed = fighters <= 0`; pull `corp_id` from participant metadata (`owner_corporation_id` for corp ships, character's corp lookup for human ships, null for unaffiliated).

**Affected events.** `combat.round_waiting` participants, `combat.round_resolved` participants, `combat.ended` participants. Same builder across all three.

**Agent-side consumption.** The task agent prompt in [combat.md](../src/gradientbang/prompts/fragments/combat.md) should be updated to explicitly reference these fields (e.g. "Check `destroyed` before committing an attack — don't spend fighters on a corpse.") — but that's a prompt edit, not an event change, and can be a follow-up.

**Risk.** Low — additive payload fields. Web client is field-tolerant (reads specific fields, doesn't exhaustive-validate).

---

### Surface F — Garrison payload ownership metadata (fixes #8, #9)

**What.** Today the `garrison` sub-object inside `combat.round_waiting` / `round_resolved` / `ended` payloads contains `owner_name` (human-readable string) but not the `owner_character_id` or `owner_corp_id`. That means:
- The LLM can't frame "your garrison" vs "their garrison" from the event alone
- XML envelope attrs (Surface D) have nothing to reference for `garrison_owner`
- Web client filter logic can't robustly match owner (names aren't unique; UUIDs are)

**Implementation.** Extend `buildGarrison` / equivalent in `combat_events.ts` to include:
- `owner_character_id: string`
- `owner_corp_id: string | null`

Pulled from the garrison record (`garrisons` table has both).

**Risk.** Medium (privacy) — exposes the owner's character ID in the payload. Recipients are scoped (participants + sector + corp + future: garrison owner themselves), so not random. But worth confirming none of those recipient classes shouldn't know who deployed the garrison. MVP: add, revisit if an incident surfaces.

**Dependency for Surfaces A, D.** These fields are referenced by `garrison.destroyed` emission (A) and the envelope attrs (D). Ship F first or bundle it into A's PR.

---

### Surface G — `ship.destroyed` ownership metadata (fixes #10, #11)

**What.** Extend [combat_finalization.ts:442](../deployment/supabase/functions/_shared/combat_finalization.ts) `ship.destroyed` emission to include:
- `owner_character_id: string` — for corp ships, the pseudo-character ID; for personal ships, the owning player's character ID
- `corp_id: string | null` — the owning corp if any

**Why.** The agent currently sees `ship.destroyed` with `player_name` and `ship_name` but can't tell whether it was *their* ship, their corp's ship, or an enemy's. Surfacing the IDs lets the prompt frame losses correctly ("We lost our freighter" vs "An enemy ship fell").

**Risk.** Medium (privacy) — same as Surface F. Scoped recipients (sector + corp), not broadcast to the world.

**Independence.** Doesn't depend on any other surface. Can ship standalone.

---

## Adjacent engine fixes

Engine-behavior fixes surfaced while building and using the harness. Not event-shape changes, but they affect the state that *gets carried* in event payloads (toll_registry is persisted via `sector_contents.combat.context`) so it's natural to land them in the same migration window. Each is independently shippable.

### Engine fix 1 — Per-payer toll semantics

**Problem.** Today, one payer paying a toll garrison ends combat for every non-aligned participant. If P1 pays and P2 just braces, the encounter resolves with `toll_satisfied` and P2 gets free passage without paying — a silent free-ride. Worse, because `pay` is currently an "everyone exits" gate, designs that make `pay` a peace-contract-with-the-garrison (rather than a full combat exit) would create a cheap PvP-escape: "pay the garrison to teleport out while a hostile player is shooting me" shouldn't be a strategy.

**Target semantics (locked in by the harness).** Paying is a **peace contract with that specific garrison only**, scoped to the payer:
- Payment deducts the toll amount and records `{ payer, amount, round }` on the garrison's `toll_registry` entry.
- The garrison cannot target a payer; the payer cannot target the garrison they paid.
- The payer remains in the encounter. If hostile non-garrison participants are still attacking them, they take damage like any other combatant and must brace/flee/fight on future rounds.
- Combat ends with `toll_satisfied` only when *every* non-friendly hostile has a payment on record for every toll garrison AND no one is actively attacking this round.

**Scenarios the fix corrects:**
1. **Free-rider scenario.** P1 pays, P2 braces → old engine: combat ends. New engine: combat continues into round 2 with P2 still owing the toll; garrison escalates next round targeting P2 only.
2. **PvP escape scenario.** P1 pays, P2 attacks P1 → new engine: garrison stands down vs. P1; P2's attack still resolves against P1 (damage normally); combat continues. P1 can't exit by paying — paying only ends their fight with the garrison.
3. **Double-charge scenario.** P1 pays in round 1; tries to pay again round 2 → rejected with "already paid, you are at peace with this garrison."
4. **Attack-after-pay.** P1 pays; tries to attack the garrison they paid → rejected with "already paid toll to X; cannot attack a garrison you are at peace with."

**Harness implementation (reference).** Already landed in the harness as of this spec:
- `allHostilesPaid(encounter, garrison, entry, corps)` in [garrison.ts](../client/combat-sim/src/engine/garrison.ts) — true when every non-friendly, non-destroyed character has a payment record.
- `anyOutstandingToll(encounter, registry, corps)` — used by the stalemate-unstuck path.
- `selectStrongestTarget(..., paidPayers)` excludes payers from the candidate pool.
- `buildTollAction` re-picks `entry.target_id` if the sticky target has since paid, and uses `allHostilesPaid` (not `entry.paid`) to decide garrison-brace-vs-escalate.
- `submitAction` attack branch rejects attacks against a garrison the actor has already paid.
- `processTollPayment` rejects re-pay from a payer whose payment is already on record.
- `checkTollStanddown` requires *all hostiles paid* AND *no active attacks*, not just "everyone braced or paid."
- Tests locked in: [combat.test.ts](../client/combat-sim/src/engine/__tests__/combat.test.ts) > "toll garrison with multiple players (per-payer semantics)" — 5 scenarios.

**Production migration work.**
- Mirror the above changes in `deployment/supabase/functions/_shared/combat_garrison.ts` + `combat_resolution.ts` + `combat_action/index.ts`.
- The `toll_registry` schema (including the `payments: Array<{ payer, amount, round }>` field) is **already correct in production** — `processTollPayment` at [combat_action/index.ts:655-671](../deployment/supabase/functions/combat_action/index.ts) already records per-payer rows. Only the read/decision logic needs updating; no DB migration needed.
- Port the 5 harness test scenarios into [combat_test.ts](../deployment/supabase/functions/tests/combat_test.ts).

**Why bundled here.** No event shape changes, but the state that drives these decisions lives in `toll_registry`, which rides on combat event payloads' `context`. Shipping it inside the same migration window keeps "combat parity with harness" coherent.

**Risk.** Medium. Changes an observable game mechanic (non-payers no longer free-ride). Worth calling out in release notes so players aren't surprised.

---

## PR rollout strategy

Each surface is deployable independently. Recommended landing order:

**PR 1 — Framework: `InferenceRule.OWNED`** (Surface C)
Pure bot-side change to `event_relay.py`. No server, no schema. Low risk, unblocks Surface A.

**PR 2 — Garrison ownership metadata** (Surface F)
Additive payload fields. Doesn't change behavior; just gives downstream surfaces the fields they need. Tests: assert new fields present on round_waiting/resolved/ended payloads in `combat_test.ts`.

**PR 3 — `garrison.destroyed` event + absent-owner routing** (Surfaces A + B, bundled)
These two are a natural pair — A's recipient list (including absent owner) exists because B's visibility rules expand. Ship together for a coherent "garrison owners now know what's happening to their garrisons" release.

**PR 4 — Garrison envelope XML attrs** (Surface D)
Depends on F landing (reads `owner_character_id`) and A landing (one of the events that gets attrs). Pure XML-builder change in `event_relay.py`.

**PR 5 — Participant metadata** (Surface E)
Independent, can land any time. Might as well ship alongside PR 2 if you want to bundle "combat event payload enrichment" into one commit — but splitting is cleaner for review and rollback.

**PR 6 — `ship.destroyed` ownership** (Surface G)
Independent. Ship whenever.

**PR 7 — Per-payer toll semantics** (Adjacent engine fix 1)
Independent — touches engine logic in `_shared/combat_garrison.ts`, `combat_resolution.ts`, and `combat_action/index.ts`. No schema change. Ship whenever; optionally bundle with the event PRs if the release note can cover both.

**Bundling option.** PRs 2+3+4+5+6 are all event-payload or XML-builder changes. PR 7 is a behavior change. If risk appetite is higher, fold 2-6 into one PR; keep PR 7 separate so the behavior change can be called out cleanly in release notes.

**Ordering constraint.** C before A. F before D. That's it. Everything else is independent.

---

## Verification

Each surface ships with targeted tests. Shared verification after all surfaces land:

### 1. Fixture-diff pass (one-shot, around the full landing)

Borrow the fixture-diff approach from the harness spec's migration section. Before the first PR lands:
- Run 5–6 canonical combat scenarios in local Supabase against the *old* server
- Capture each event sequence to `deployment/supabase/functions/tests/fixtures/combat_event_parity/`

After all PRs land:
- Re-run the same scenarios
- Diff the event sequences, focusing on `{type, payload keys, recipient set}`
- Expected diffs: every net-new field/event called out in this spec. No unexpected diffs.

Scenarios:
- 1v1 character combat
- Character + corp ship vs. 2-character opposition
- Toll-mode garrison with paying participant
- Defensive garrison + absent owner (validates Surface B — owner now sees events they didn't before)
- Garrison destruction (validates Surface A — new event appears; owner's recipient list includes them)
- Character vs. enemy corp ship with both corp-member observers (validates corp-id propagation)

### 2. Integration tests

Extend [`deployment/supabase/functions/tests/combat_test.ts`](../deployment/supabase/functions/tests/combat_test.ts) with:
- Per-surface test cases (enumerated inline above)
- The four harness garrison-routing scenarios ported from `client/combat-sim/src/engine/__tests__/agent.test.ts`

Run via `bash deployment/supabase/functions/tests/run_tests.sh`.

### 3. Bot-side integration

Extend Python tests under `scripts/run-integration-tests.sh` to assert:
- `garrison.destroyed` triggers a voice-agent LLM call only for the owner (InferenceRule.OWNED)
- Round events to absent garrison owners trigger silent append, not voice narration (ON_PARTICIPANT does this correctly)

### 4. Manual end-to-end

Local bot + local Supabase + production client:
1. Deploy a garrison in sector A as player-1
2. Move player-1 to sector B
3. As player-2, engage the garrison in sector A
4. Expected: player-1's voice agent stays silent during round resolution. Player-1 can ask "how's my garrison doing?" and get a real answer from context.
5. Destroy the garrison. Player-1's voice agent speaks: "Commander, your garrison in sector A has fallen."
6. Check web client: garrison marker removed on `garrison.destroyed`; activity log shows the event.

---

## Critical files

### Server-side (edge functions)

**New / moved:**
- `deployment/supabase/functions/_shared/combat_events.ts` — extend `buildParticipant`, `buildGarrison` (Surfaces E, F); potentially add `buildGarrisonDestroyed` (Surface A)
- `deployment/supabase/functions/_shared/combat_finalization.ts` — emit `garrison.destroyed` before row delete (Surface A); extend `ship.destroyed` payload (Surface G)
- `deployment/supabase/functions/_shared/visibility.ts` — expand recipient computation to include absent garrison owners + their corp members (Surface B); add `garrisonDestroyedRecipients` helper (Surface A)
- `deployment/supabase/functions/_shared/event_identity.ts` — register `garrison.destroyed` type (Surface A)

**Indirectly affected (verify, don't necessarily edit):**
- `deployment/supabase/functions/combat_initiate/index.ts` — emits `round_waiting`; verify new recipient set propagates
- `deployment/supabase/functions/_shared/combat_resolution.ts` — emits `round_resolved`, `ended`; verify recipient expansion

**Engine fix 1 (per-payer toll):**
- `deployment/supabase/functions/_shared/combat_garrison.ts` — add `allHostilesPaid` / `anyOutstandingToll` helpers; update `selectStrongestTarget` to exclude payers; rewrite `buildTollAction` to use per-payer state
- `deployment/supabase/functions/_shared/combat_resolution.ts` — rewrite `checkTollStanddown` to require all hostiles paid + no active attacks; update stalemate-unstuck to use `anyOutstandingToll`
- `deployment/supabase/functions/combat_action/index.ts` — reject re-pay in `processTollPayment`; reject attacks against a paid garrison in action validation

### Bot-side (Python)

- `src/gradientbang/pipecat_server/subagents/event_relay.py`
  - Add `InferenceRule.OWNED` enum value + `_should_run_llm()` branch (Surface C)
  - Register `EventConfig` for `garrison.destroyed` (Surface A)
  - Add `_summarize_garrison_destroyed()` voice-summary function (Surface A)
  - Extend XML builder to support multi-attribute envelopes + add per-event attr lists (Surface D)
- `src/gradientbang/utils/summary_formatters.py` — potential home for the new summary function if convention is to live there
- `src/gradientbang/prompts/fragments/combat.md` — reference new participant fields (`fighters`, `destroyed`, `corp_id`) in prompt guidance (follow-up, not blocking)

### Client-side (web)

- `client/app/src/GameContext.tsx` — add `garrison.destroyed` handler: remove garrison marker + optional toast (Surface A)
- Consider: surface new `owner_character_id` / `corp_id` fields in combat UI where useful (e.g. color-code corp-mate participants) — follow-up, not in scope

### Tests

- `deployment/supabase/functions/tests/combat_test.ts` — garrison routing scenarios, payload-shape assertions, `garrison.destroyed` emission
- Python integration tests under `scripts/run-integration-tests.sh` — bot-side routing correctness
- `deployment/supabase/functions/tests/fixtures/combat_event_parity/` — new fixture directory for the one-shot diff pass

### Reference (read-only)

- `client/combat-sim/src/engine/engine.ts` — canonical implementation of every payload shape and recipient computation
- `client/combat-sim/src/relay/event_relay.ts` — canonical EventConfig registry
- `client/combat-sim/src/engine/__tests__/agent.test.ts` — canonical garrison routing test suite
- `docs/combat-debug-harness-spec.md` — harness spec; overlapping migration principles
- `docs/combat-strategies-spec.md` — strategies spec; separate track but related surface

---

## Risks

1. **Privacy leak via newly-exposed IDs.** Surfaces F, G, E#7 put `owner_character_id` / `corp_id` on payloads that were previously anonymized. Mitigation: confirm recipients are already scoped to stakeholders (visibility.ts); audit before deploy. If concerns surface, add per-recipient redaction (mask corp_id when recipient is a non-corp-member sector observer).

2. **Event recipient set growth → polling load.** Surface B expands recipients for combat events (absent garrison owners + their corp members now receive what they didn't before). Each additional recipient means one more row in the `events` table per event and one more client consuming it via polling. For N-person corps × M rounds, this scales — worth sanity-checking the volume. Mitigation: if volume becomes an issue, narrow "corp members of garrison owner" to "online members" or drop that tier.

3. **RTVI payload size creep.** Each new field on combat events adds bytes sent to the web client. Not a problem for a single combat, could matter for long combats (`combat.ended.logs[]` already carries round-by-round detail). Acceptable for MVP; revisit if frame size becomes a concern.

4. **Double-narration risk on `garrison.destroyed`.** If both `InferenceRule.OWNED` fires for owner AND `ON_PARTICIPANT` already fired for a same-sector participant-owner (owner is both in sector AND owner of garrison), the voice agent might narrate the round and the destruction in the same beat. Verify: the OWNED path should only fire once per event per player; shouldn't interact with ON_PARTICIPANT from a prior event. Unit test this explicitly.

5. **Stale harness drift.** Any harness-side change to event shapes between now and the migration lands creates new discrepancies. Mitigation: lock the parity target by re-generating this table before each PR lands; update the spec as a living doc.

6. **Web client tolerance regression.** New payload fields require the web client to gracefully ignore them (it already does, but assumptions rot). Smoke-test the web client against the new payloads before deploy.

---

## Out-of-scope follow-ups

Tracked so they're not lost:

- Prompt updates in `combat.md` to reference new fields (`fighters`, `destroyed`, `corp_id`) in agent guidance
- Consider `InferenceRule.OWNED` for other events (e.g. `ship.destroyed` of your own ship — arguably deserves voice narration beyond what `round_resolved` already says)
- Multi-garrison encounter support — prod currently only includes the primary garrison in combat payloads; harness may support multi-garrison. Flag for strategies-era combat where multiple garrisons in a sector becomes plausible.
- Consider harness-only debug events (`world.reset`, `harness.timer_toggled`, `forceEndCombat`) as candidates for *production* admin tooling — but that's an admin-surface question, not combat-event parity.
