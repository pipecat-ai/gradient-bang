# Combat Eval Scenarios — Production Voice Coverage

Eval plan for testing the production combat implementation via the voice agent. Each entry describes a scripted scenario the eval harness can replay against a live (or test) Supabase + Pipecat bot, then assert on expected outputs.

## What we're testing

For each scenario, the eval should verify some combination of:

1. **Voice agent tool calls** — the right tool fires with the right args from a player utterance
2. **Voice narration content** — POV-aware summary text matches expected framing
3. **Event flow** — the player receives the events they should (and doesn't receive ones they shouldn't)
4. **XML envelope shape** — combat events arrive in LLM context with correct attrs (`combat_id`, `garrison_id`, etc.)
5. **Game state transitions** — DB ends in the expected end-state (ship sector, fighter counts, garrison rows)
6. **Strategy injection** — combat doctrine + custom prompt land in context on round 1

## Scenario script conventions

Every scenario script uses these blocks:

- **Setup** — world state pre-conditions (characters, ships, garrisons, sectors, corps, strategies)
- **Script** — alternating `[Player]` utterances and `[Expected]` system reactions, in chronological order
- **Expected** — final assertions (events received, end-state, narration substrings)

`[Player]` utterances are spoken to the voice agent. Bot responses, tool calls, and emitted events are tracked under `[Expected]`.

Test characters are referred to as P1, P2, P3. Corp ships as CS1, CS2. Garrisons as G1, G2.

---

## 1. Combat initiation

### 1.1 Player initiates 1v1 combat by voice

**Description:** Voice agent translates "attack the other ship here" into a `combat_initiate` tool call when a hostile is in sector.

**Setup:** P1 (initiator) and P2 in sector 42. No corp affiliation. P1's ship has 100 fighters.

**Script:**
- `[Player]` "Attack that ship."
- `[Expected]` Voice agent calls `combat_initiate` with `target_id=P2`. Bot replies acknowledging combat started. `combat.round_waiting` round=1 event arrives in P1's context.

**Expected:** P1 receives `combat.round_waiting` (DIRECT POV); P1's combat doctrine (default `balanced`) injected ahead of round-1 event; combat.md preamble loaded; tool call args correctly identify P2 by name.

---

### 1.2 Auto-engage on entering hostile garrison sector

**Description:** Player moves into a sector with an offensive garrison; combat auto-initiates without player command.

**Setup:** Offensive garrison G1 owned by P2 in sector 42. P1 in sector 41. P1 not a corp-mate of P2.

**Script:**
- `[Player]` "Move to sector 42."
- `[Expected]` Voice agent calls move tool. Movement completes. `combat.round_waiting` arrives. Voice narrates the engagement.

**Expected:** `combat.round_waiting` round=1 arrives at P1; voice narration uses garrison-aware POV ("you've entered a hostile garrison's sector"); doctrine injected; XML envelope carries `garrison_id` + `garrison_owner` attrs.

---

### 1.3 Auto-engage when hostile enters your sector

**Description:** Player is stationary; an offensive garrison is deployed in their sector by an enemy. Combat auto-initiates.

**Setup:** P1 in sector 42. P2 in sector 42. P2 deploys an offensive garrison.

**Script:**
- `[Expected]` `combat.round_waiting` arrives at P1 unprompted. Voice narrates incoming engagement.

**Expected:** P1 receives the event without any player utterance; voice narration is unprompted; doctrine + combat.md inject; event delivered with `garrison_id` envelope attr.

---

### 1.4 Initiation rejected — alone in sector

**Description:** Voice agent must surface the rejection cleanly when there's no targetable opponent.

**Setup:** P1 alone in sector 42.

**Script:**
- `[Player]` "Attack."
- `[Expected]` Voice agent attempts `combat_initiate`, server rejects, bot relays "no opponent" gracefully without confabulating combat state.

**Expected:** No `combat.round_waiting` event; voice agent narrates the rejection reason; no combat row created.

---

### 1.5 Own offensive garrison + only owner in sector — no auto-init

**Description:** Deploying an offensive garrison while alone in the sector should not start a combat against yourself.

**Setup:** P1 alone in sector 42.

**Script:**
- `[Player]` "Deploy offensive garrison with 50 fighters here."
- `[Expected]` `garrison.deployed` event arrives; NO `combat.round_waiting`.

**Expected:** Voice confirms deployment without mentioning combat; no combat row exists; no doctrine injection.

---

### 1.6 Offensive garrison + corp-mate in sector — no auto-init

**Description:** Corp-mate presence does not trigger your offensive garrison.

**Setup:** P1 and P3 in sector 42, same corp.

**Script:**
- `[Player P1]` "Deploy offensive garrison."
- `[Expected]` Garrison deployed; no `combat.round_waiting` for either P1 or P3.

**Expected:** No combat row; both players' voice agents stay silent on combat.

---

### 1.7 Move into corp-mate's offensive garrison sector — no engage

**Description:** Walking into a sector with a corp-mate's offensive garrison does not auto-engage.

**Setup:** P3 owns offensive garrison G1 in sector 42. P1 in sector 41 (P1 + P3 same corp).

**Script:**
- `[Player P1]` "Move to 42."
- `[Expected]` Movement completes; no combat.

**Expected:** P1 ends up in sector 42 unmolested; no `combat.round_waiting`; voice does not narrate combat.

---

## 2. Direct participant — actions

### 2.1 Player attacks via voice

**Description:** Voice translates "attack with 30" into a properly formed `combat_action` tool call.

**Setup:** Active combat between P1 and P2 in sector 42, round 1 waiting.

**Script:**
- `[Player]` "Attack with thirty."
- `[Expected]` `combat_action` tool fires with `action="attack"`, `commit=30`, `target_id=P2`. `combat.action_accepted` arrives.

**Expected:** Action recorded; `combat.action_accepted` carries correct commit + target; voice confirms briefly.

---

### 2.2 Player braces via voice

**Description:** "Hold position" / "brace" / "defend" all map to a brace action.

**Setup:** Active combat round 1 waiting.

**Script:**
- `[Player]` "Brace."
- `[Expected]` `combat_action` tool fires with `action="brace"`. `action_accepted` arrives.

**Expected:** Brace recorded with no target/commit; voice confirms.

---

### 2.3 Round resolves — voice narrates damage

**Description:** After both participants submit, `combat.round_resolved` fires; voice surfaces the player's own loss + opponent state.

**Setup:** Both P1 and P2 submitted attacks. Tick fires.

**Script:**
- `[Expected]` `combat.round_resolved` arrives at P1. Voice narration mentions own fighter loss + opponent's remaining fighters.

**Expected:** Voice summary surfaces P1's own damage line; participant array in payload carries `fighters` / `destroyed` flags; XML attrs include `combat_id`.

---

### 2.4 Combat ends in victory

**Description:** When opponent is destroyed, `combat.ended` arrives DIRECT to the winner with their own ship state intact.

**Setup:** P1 attack overwhelms P2. P2's ship → escape pod.

**Script:**
- `[Expected]` `combat.round_resolved` shows P2 destroyed; `combat.ended` follows with end_state including P2 defeat. Voice narrates victory.

**Expected:** `combat.ended` payload's `ship` block is P1's own ship (not P2's); voice framing is victorious; `ship.destroyed` event also arrives separately for P2.

---

### 2.5 Combat ends in defeat — your ship destroyed

**Description:** Player loses; `combat.ended` voice framing reflects defeat; ship becomes escape pod.

**Setup:** P2 attack overwhelms P1.

**Script:**
- `[Expected]` `ship.destroyed` arrives at P1 (OWNED inference fires); `combat.ended` arrives with P1's ship as escape pod.

**Expected:** Voice narration uses defeat framing; ship.destroyed `inference=OWNED` triggers an LLM call only for P1; ship block in `combat.ended` shows escape pod.

---

### 2.6 Mid-combat status query

**Description:** Player asks "what's my shield level?" between rounds; voice answers from accumulated context, not fabrication.

**Setup:** P1 mid-combat, round 2 waiting. Round 1 resolved with shield damage on P1.

**Script:**
- `[Player]` "What's my shield level?"
- `[Expected]` Voice answers with the actual `shield_integrity` value from the round-1 `round_resolved` payload.

**Expected:** Answer matches the recorded post-round-1 shield value within rounding; no tool call needed (context-only); voice does not invent numbers.

---

## 3. Flee

### 3.1 Successful flee via voice

**Description:** "Flee to sector X" is parsed and dispatched correctly; ship relocates.

**Setup:** Active combat in sector 42. P1 has fighters remaining. Sector 41 is adjacent.

**Script:**
- `[Player]` "Flee to sector 41."
- `[Expected]` `combat_action` with `action="flee"`, `destination_sector=41`. Round resolves; `combat.ended` arrives with end_state `<P1>_fled`.

**Expected:** P1's ship at sector 41 in DB post-resolution; `has_fled=true` and `fled_to_sector=41` on participant payload (Phase 2.2 surface); voice narrates successful escape.

---

### 3.2 Flee without destination — fallback

**Description:** "Flee" with no destination should pick an adjacent sector (or sector-1 fallback).

**Setup:** Combat in sector 42.

**Script:**
- `[Player]` "Run."
- `[Expected]` `combat_action` flee with no `destination_sector`; server picks adjacent sector.

**Expected:** Ship ends up in an adjacent sector; voice narration acknowledges; flee fields surfaced in payload.

---

### 3.3 Failed flee while attacked

**Description:** Flee attempted while opponent is attacking — flee is marked but combat continues.

**Setup:** P1 attempts flee, P2 submits attack.

**Script:**
- `[Player]` "Flee."
- `[Expected]` `combat.round_resolved` shows attack landed, flee marked but no movement.

**Expected:** P1 still in sector 42; combat.round_waiting round 2 arrives; voice indicates flee failed.

---

### 3.4 Combat handoff after flee — left encounter goes silent

**Description:** Once P1 flees, subsequent rounds of the *original* encounter should not arrive at P1 or be narrated by their voice agent.

**Setup:** P1 flees from combat in sector 42 to sector 41. Combat continues in sector 42 with P2 vs G1.

**Script:**
- `[Expected]` `combat.round_resolved` round 2+ for the original encounter does NOT arrive at P1.

**Expected:** P1's event log stops receiving updates from sector 42's encounter after flee resolves; P1's voice does not narrate ongoing combat for the encounter they left; recipient set correctly recomputes after participant departure.

---

## 4. Toll garrison — single payer

### 4.1 Encounter toll garrison

**Description:** Player walks into a toll-mode garrison sector; voice surfaces toll demand on round 1.

**Setup:** Toll garrison G1 in sector 42 (toll_amount=500). P1 with 1000 credits enters.

**Script:**
- `[Player]` "Move to 42."
- `[Expected]` Auto-engage; round 1 waiting arrives; garrison action shown as `pay/demand`; voice narrates the demand.

**Expected:** `combat.round_waiting` payload shows garrison with `mode="toll"`, `toll_amount=500`; voice prompts "pay 500 credits or fight."

---

### 4.2 Pay the toll → end combat

**Description:** "Pay" maps to a pay action; combat ends `toll_satisfied`; credits deducted.

**Setup:** From 4.1.

**Script:**
- `[Player]` "Pay it."
- `[Expected]` `combat_action` with `action="pay"`. `combat.ended` with end_state `toll_satisfied`.

**Expected:** P1 credits reduced by 500; `entry.payments[]` has a row for P1; voice confirms peace; ship still in sector 42.

---

### 4.3 Refuse → escalation

**Description:** Refusing pay on round 1 doesn't end combat; round 2 garrison escalates to attack.

**Setup:** From 4.1.

**Script:**
- `[Player]` "I won't pay. Brace."
- `[Expected]` Round 1 resolves; round 2 waiting arrives; garrison's action flips from demand to attack.

**Expected:** Round 2 `combat.round_waiting` shows garrison committing fighters; voice narrates escalation; no `toll_satisfied` end-state.

---

### 4.4 Insufficient credits → pay rejected

**Description:** Voice agent surfaces server-side pay rejection cleanly when credits are too low.

**Setup:** P1 has 100 credits, toll demand is 500.

**Script:**
- `[Player]` "Pay."
- `[Expected]` `combat_action` rejected by server (insufficient credits); voice relays the rejection.

**Expected:** No payment recorded; combat continues; voice doesn't confabulate a successful payment.

---

## 5. Toll garrison — per-payer (Phase 2.1 target)

> These evals validate the per-payer semantics that Phase 2.1 lands. Run in two configurations: pre-2.1 (capture today's behaviour as the regression baseline) and post-2.1 (assert the new contract).

### 5.1 P1 pays, P2 braces — combat continues

**Description:** P2 cannot free-ride on P1's payment; garrison continues against P2.

**Setup:** Toll garrison G1, P1 + P2 in sector 42 (different corps).

**Script:**
- `[P1]` "Pay."
- `[P2]` "Brace."
- `[Expected]` Round 1 resolves: P1 paid, garrison did not stand down. Round 2 garrison targets P2.

**Expected (post-2.1):** No `toll_satisfied`; garrison's round-2 action is attack against P2; P1 still in encounter but garrison cannot target P1.

---

### 5.2 Paid payer cannot pay again

**Description:** Re-pay attempt is rejected at server level; voice surfaces the rejection.

**Setup:** P1 already paid the toll on round 1. Round 2 in progress.

**Script:**
- `[P1]` "Pay again."
- `[Expected]` Server rejects with "already at peace with this garrison"; voice relays.

**Expected:** No second deduction; `entry.payments[]` has only P1's original row; voice doesn't claim payment succeeded.

---

### 5.3 Paid payer cannot attack the garrison they paid

**Description:** Attack action against a paid garrison is rejected.

**Setup:** P1 paid garrison G1 on round 1. Round 2 in progress.

**Script:**
- `[P1]` "Attack the garrison."
- `[Expected]` Server rejects: "you've paid this garrison; cannot attack."

**Expected:** No attack recorded for P1 against G1; voice relays the contract violation cleanly.

---

### 5.4 All hostiles paid → combat ends

**Description:** When every non-friendly has paid AND no one is attacking, combat ends `toll_satisfied`.

**Setup:** P1 + P2 vs G1. Both pay round 1.

**Script:**
- `[P1]` "Pay."
- `[P2]` "Pay."
- `[Expected]` `combat.ended` with end_state `toll_satisfied`.

**Expected:** Combat row closed; both payers' credits deducted; both have rows in `entry.payments[]`; voice confirms.

---

## 6. Commander surfaces — garrison deploy / manage

### 6.1 Deploy defensive garrison via voice

**Description:** "Deploy a garrison here, defensive" maps to the right tool with the right mode.

**Setup:** P1 in sector 42 with sufficient fighters + credits.

**Script:**
- `[Player]` "Deploy a defensive garrison with 50 fighters here."
- `[Expected]` `garrison_deploy` tool (or its production name) with `mode="defensive"`, `fighter_count=50`. `garrison.deployed` event fires.

**Expected:** Garrison row in DB with mode=defensive; event arrives at sector observers; voice confirms deployment.

---

### 6.2 Change garrison mode via voice

**Description:** "Switch my garrison to toll" updates mode and emits `garrison.mode_changed`.

**Setup:** P1 owns G1 in sector 42 (defensive). P1 anywhere.

**Script:**
- `[Player]` "Set my garrison in 42 to toll mode at 500 credits."
- `[Expected]` `garrison_set_mode` tool fires with `mode="toll"`, `toll_amount=500`. `garrison.mode_changed` event arrives.

**Expected:** DB row updated; event recipients include sector observers + corp + owner; voice confirms.

---

### 6.3 Disband garrison → fighters return

**Description:** "Disband my garrison" calls the harvest tool; `garrison.collected` fires; fighters return to ship.

**Setup:** P1 owns G1 with 100 fighters. P1 in sector 42.

**Script:**
- `[Player]` "Pull my garrison back."
- `[Expected]` Tool fires; `garrison.collected` event arrives; ship's fighter count incremented by 100.

**Expected:** Garrison row deleted; fighters returned; voice confirms with new ship fighter count.

---

## 7. Corp ship POV — owner observing remotely

### 7.1 Corp owner remote observes corp ship in combat

**Description:** When a corp ship is in combat, the corp owner (out of sector) receives round events via corp fan-out with silent append (no voice narration).

**Setup:** P1 owns corp ship CS1. CS1 in sector 50. P1 in sector 1. CS1 engaged by hostile.

**Script:**
- `[Expected]` `combat.round_waiting` arrives at P1 silently (no voice narration). XML envelope carries `combat_id`, `ship_id`, `ship_name`.

**Expected:** Event in P1's context; voice agent does NOT narrate (POV is OBSERVED via corp ship); summary uses corp-ship framing if surfaced.

---

### 7.2 Corp owner notified when corp ship is destroyed

**Description:** `ship.destroyed` for a corp ship triggers `InferenceRule.OWNED` voice narration only for the owner.

**Setup:** From 7.1; CS1 destroyed.

**Script:**
- `[Expected]` `ship.destroyed` arrives at P1; voice narrates "we lost CS1 in sector 50."

**Expected:** Voice narration fires for P1 (OWNED); other corp members get silent append; salvage event also arrives.

---

### 7.3 Corp ship's `action_accepted` does NOT fan out

**Description:** A corp ship's submitted action is private to the ship; corp owner does NOT get the action_accepted event.

**Setup:** CS1 mid-combat submits an attack.

**Script:**
- `[Expected]` `combat.action_accepted` arrives at CS1 (the ship's own context) but NOT at P1.

**Expected:** P1's event log doesn't contain action_accepted for CS1; CS1 sees its own.

---

### 7.4 Corp ship pays toll → succeeds with corp-ship credits

**Description:** A corp ship can pay the toll using its own credit balance; voice narration to the corp owner confirms.

**Setup:** Corp ship CS1 (1000 credits) in sector 42 facing toll garrison G1 (toll=500). P1 (owner) in sector 1.

**Script:**
- CS1's task agent decides to pay (or owner via voice command issues "have CS1 pay the toll" if such a command path exists).
- `[Expected]` `combat_action` with `action="pay"` from CS1's actor context. `combat.ended` with `toll_satisfied`.

**Expected:** CS1's credits debited by 500; `entry.payments[]` row identifies CS1 as payer; `combat.ended` reaches P1 via corp fan-out; P1's voice narrates corp-ship outcome.

---

### 7.5 Corp ship insufficient credits — pay rejected

**Description:** Corp ship without enough credits gets a clean rejection that surfaces correctly to the owner.

**Setup:** CS1 with 100 credits, toll demand 500.

**Script:**
- `[Expected]` Pay action rejected at server. Combat continues into round 2.

**Expected:** No deduction; P1 (owner) sees the failure via the action_accepted/round_resolved event flow; voice does not claim payment succeeded; P1 can issue alternate orders.

---

## 8. Garrison owner POV — remote observation

### 8.1 Remote owner gets silent append on round events

**Description:** Garrison under attack — owner is in another sector. Round events arrive silently in their context.

**Setup:** P1 owns G1 in sector 42. P1 in sector 1. P2 attacks G1.

**Script:**
- `[Expected]` `combat.round_waiting` and `combat.round_resolved` arrive at P1 with silent append (ON_PARTICIPANT skips inference for non-participants).

**Expected:** P1's voice does not narrate during rounds; LLM context includes the events with `garrison_id` + `garrison_owner` attrs; P1 can later ask "how's my garrison?" and answer correctly.

---

### 8.2 Garrison destroyed — voice narrates loss to owner

**Description:** `garrison.destroyed` fires `InferenceRule.OWNED`; owner's voice agent narrates the loss.

**Setup:** From 8.1; G1's fighters reduced to 0.

**Script:**
- `[Expected]` `garrison.destroyed` event with full payload (owner_character_id, owner_corp_id, mode, sector). Voice narrates "Commander, your garrison in sector 42 has fallen."

**Expected:** Voice fires only for P1 (OWNED rule); corp-mates of P1 get silent append; uninvolved players get nothing; web client removes garrison marker on event.

---

### 8.3 Corp-mate of garrison owner — silent append

**Description:** A corp-mate (non-owner) of the garrison owner receives round events but voice stays silent.

**Setup:** P3 is in P1's corp. G1 owned by P1, attacked.

**Script:**
- `[Expected]` Round events arrive at P3 silently.

**Expected:** P3's voice agent does not narrate; events appear in context; querying "what's happening with our corp's garrison" yields a real answer.

---

### 8.4 Cross-sector context query — "how's my garrison?"

**Description:** This is the headline payoff of the new event routing — silent context append accumulates round-by-round, then the player can query it without a tool call.

**Setup:** P1 owns G1 in sector 42; P1 in sector 1. G1 has been in combat for 3 rounds against P2 (silent append accumulated all three rounds).

**Script:**
- `[Player P1]` "How's my garrison in sector 42 doing?"
- `[Expected]` Voice answers with real fighter count, recent damage, and attacker identity from the accumulated `combat.round_waiting` / `round_resolved` payloads.

**Expected:** Answer contains real numbers (current `fighters` value, recent fighter loss, attacker name); no tool call required (context-only); voice does not fabricate state; XML envelope attrs (`garrison_id`, `garrison_owner`) made the events filterable in context.

---

## 9. Combat strategy injection (Phase 1 surface, already wired)

### 9.1 Default doctrine on round 1 when no strategy set

**Description:** With no `combat_strategies` row, round 1 injects the `balanced` doctrine + combat.md fragment.

**Setup:** P1 with no strategy set; combat initiates.

**Script:**
- `[Expected]` Round-1 `combat.round_waiting` event preceded by combat.md preamble + balanced doctrine in LLM context.

**Expected:** LLM context has both fragments queued before the event; doctrine header reads "default 'balanced'"; subsequent voice recommendations align with balanced doctrine.

---

### 9.2 Custom doctrine + custom prompt injected

**Description:** With offensive doctrine + custom prompt set, both inject on round 1.

**Setup:** P1 has `combat_strategies` row: `template=offensive`, `custom_prompt="Always target the smallest ship first."`

**Script:**
- `[Expected]` Round-1 preamble shows offensive doctrine + custom prompt block.

**Expected:** Both fragments in context ahead of round-1 event; voice recommendations bias offensive; custom prompt visible in inference traces.

---

### 9.3 Set strategy via voice mid-game

**Description:** "Set my ship's strategy to defensive" calls the strategy tool correctly.

**Setup:** P1 idle.

**Script:**
- `[Player]` "Set my ship to defensive doctrine."
- `[Expected]` `ship_strategy` tool fires with `template="defensive"`. `ships.strategy_set` event arrives. UI panel reflects.

**Expected:** DB row upserted; event flows to web client; next combat injects defensive doctrine.

---

### 9.4 Add custom prompt without changing template (merge semantics)

**Description:** Passing only `custom_prompt` to the strategy tool keeps the existing template.

**Setup:** P1 has `template=offensive` already set.

**Script:**
- `[Player]` "Tell my ship to always go after Joe Christmas."
- `[Expected]` `ship_strategy` tool fires with `custom_prompt` only. Server merges with current template=offensive.

**Expected:** Final row has template=offensive + the new custom_prompt; voice doesn't claim the doctrine changed.

---

### 9.5 Strategy → action alignment (LLM-judge eval)

**Description:** When the player asks "what should I do?" mid-combat, the voice's recommendation should reflect the active doctrine. Run two configurations of the same combat with offensive vs defensive doctrine; compare recommendations.

**Setup:** Two parallel runs, identical combat setup (P1 vs P2, equal fighters). Run A: P1 has offensive doctrine. Run B: P1 has defensive doctrine.

**Script:**
- `[Player P1]` (both runs) "What should I do?"
- `[Expected, Run A]` Voice recommends an attack action with significant commit.
- `[Expected, Run B]` Voice recommends brace or low-commit attack.

**Expected:** An LLM judge confirms the two recommendations are meaningfully different and each aligns with its doctrine. Substring match alone is insufficient — use a judge prompt comparing the two responses against the doctrine descriptions in `combat_strategies/{template}.md`.

---

### 9.6 Rapid back-to-back combats — doctrine re-injects

**Description:** Combat ends; new combat starts immediately; doctrine re-injects on round 1 of the second combat (combat.md does NOT — it's once-per-session).

**Setup:** P1 wins combat 1 in sector 42. P3 enters sector 42. P1 initiates combat 2 against P3.

**Script:**
- `[Expected]` `combat.ended` for combat 1, then `combat.round_waiting` round=1 for combat 2 with the doctrine preamble re-queued.

**Expected:** Doctrine fragment present in context ahead of combat 2's round 1 (`combat_get_strategy` was refetched); combat.md is NOT re-injected (the relay's `_combat_md_loaded` flag is once-per-session). If P1's strategy was edited between combats, combat 2 sees the updated doctrine.

---

## 10. Multi-participant scenarios

### 10.1 3-way combat — events to all stakeholders

**Description:** Three characters in combat; each receives round events with their own POV-correct ship block.

**Setup:** P1, P2, P3 all in sector 42. P1 initiates against P2; P3 joins.

**Script:**
- `[Expected]` All three receive `combat.round_waiting`. Each voice agent narrates from their own POV.

**Expected:** Three independent event streams; each `combat.ended` payload's ship block matches the recipient (not someone else's); recipient set deduped.

---

### 10.2 Observer joins existing combat

**Description:** P3 arrives in sector mid-combat; subsequent events include them.

**Setup:** P1 vs P2 mid-combat in sector 42. P3 enters from sector 41.

**Script:**
- `[Player P3]` "Move to 42."
- `[Expected]` Movement completes; subsequent `combat.round_resolved` includes P3 as recipient (sector observer, round 2+ may filter).

**Expected:** P3 has events from move forward but NOT prior rounds; if P3 then calls `combat_initiate`, they join as participant.

---

### 10.3 Sector observer — uninvolved player

**Description:** P3 is in the sector but not a participant; round 1 fan-out includes them; round 2+ does not.

**Setup:** P3 in sector 42 (not a corp-mate of either fighter).

**Script:**
- `[Expected]` Round-1 `combat.round_waiting` arrives at P3; round 2+ does NOT arrive.

**Expected:** P3 sees round 1 only; voice agent for P3 uses sector-only POV ("this combat event is not your fight"); no doctrine injection (P3 is not a participant).

---

### 10.4 `combat.ended` per-viewer personalization

**Description:** Each recipient's `combat.ended` payload carries *their own* ship block, not someone else's. Pre-Phase-1 there were bugs where a defeated player saw a winner's ship details.

**Setup:** 3-way combat (P1, P2, P3) in sector 42 ends. P3's ship destroyed.

**Script:**
- `[Expected]` Three separate `combat.ended` events (one per character recipient). P1's payload's `ship` block is P1's ship (intact); P2's is P2's; P3's is their escape pod.

**Expected:** No cross-contamination of ship blocks between recipients; P3's voice narration uses defeat framing with escape-pod state; P1/P2's voice narration uses victory framing.

---

## 11. Edge cases — tool / agent rejections

### 11.1 Reject attack on destroyed target

**Description:** After a participant dies, voice agent should not let the player attack the corpse.

**Setup:** Combat with P1, P2, P3. P3 destroyed in round 1.

**Script:**
- `[P1]` "Attack P3."
- `[Expected]` Voice agent inspects `participants[].destroyed` → refuses to call `combat_action` against P3, or calls and surfaces the server rejection cleanly.

**Expected:** No attack recorded against P3; voice steers P1 to a live target; LLM context shows P3 with `destroyed: true`.

---

### 11.2 Reject move during combat

**Description:** "Move to sector X" while in combat is rejected at server level.

**Setup:** P1 mid-combat.

**Script:**
- `[Player]` "Go to sector 41."
- `[Expected]` Tool fires; server rejects ("cannot move while in combat"); voice relays.

**Expected:** P1 stays in sector 42; voice doesn't claim movement succeeded.

---

### 11.3 Reject action after combat.ended

**Description:** Submitting an action after combat has ended should be cleanly rejected.

**Setup:** Combat just ended. `combat.ended` arrived.

**Script:**
- `[Player]` "Attack with 50."
- `[Expected]` Either voice agent declines (knows combat is over) or server rejects.

**Expected:** No action submitted; voice acknowledges combat is over.

---

### 11.4 Auto-brace on round timeout

**Description:** Player doesn't respond before round deadline; tick fires; auto-brace recorded.

**Setup:** P1 mid-combat, round 1 waiting. No utterance.

**Script:**
- `[Expected]` Round deadline elapses; tick auto-resolves with brace for P1; round_resolved arrives.

**Expected:** Round resolved with P1's action as brace (timed_out flag if surfaced); voice narrates next round.

---

### 11.5 Movement validation edges

**Description:** Voice surfaces server rejections cleanly for invalid moves outside combat.

**Setup:** P1 in sector 42 (no combat).

**Script:**
- `[Player]` "Move to 42." (same sector)
- `[Expected]` Server rejects ("already in sector"); voice relays.
- `[Player]` "Move to sector 99." (non-adjacent)
- `[Expected]` Server rejects ("not adjacent"); voice relays.

**Expected:** P1 stays in sector 42 in both cases; voice does not fabricate movement success; rejection reasons surface in narration.

---

## 12. Salvage

### 12.1 Salvage created on ship destruction

**Description:** When a ship is destroyed, `salvage.created` fires; sector observers receive it.

**Setup:** Combat ends with P2's ship destroyed.

**Script:**
- `[Expected]` `salvage.created` event arrives at sector observers + corp.

**Expected:** Salvage row in DB; event payload has salvage details; voice may narrate availability.

---

### 12.2 Player collects salvage via voice

**Description:** "Collect the salvage here" maps to `salvage_collect` tool.

**Setup:** Salvage in sector 42; P1 in sector 42 with cargo space.

**Script:**
- `[Player]` "Pick up the salvage."
- `[Expected]` `salvage_collect` tool fires; `salvage.collected` event arrives; cargo updated.

**Expected:** Salvage row consumed; ship cargo reflects pickup; voice confirms with new cargo state.

---

## Appendix — Coverage matrix

| Track | Evals |
|---|---|
| Initiation + auto-engagement | 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7 |
| Direct actions + status query | 2.1, 2.2, 2.3, 2.4, 2.5, 2.6 |
| Flee + handoff | 3.1, 3.2, 3.3, 3.4 |
| Toll (single) | 4.1, 4.2, 4.3, 4.4 |
| Toll (per-payer, 2.1 target) | 5.1, 5.2, 5.3, 5.4 |
| Garrison commander | 6.1, 6.2, 6.3 |
| Corp ship POV + economic actions | 7.1, 7.2, 7.3, 7.4, 7.5 |
| Garrison owner POV + cross-sector query | 8.1, 8.2, 8.3, 8.4 |
| Strategy injection + alignment | 9.1, 9.2, 9.3, 9.4, 9.5, 9.6 |
| Multi-participant + personalization | 10.1, 10.2, 10.3, 10.4 |
| Validation / edge | 11.1, 11.2, 11.3, 11.4, 11.5 |
| Salvage | 12.1, 12.2 |

**Total: 53 scenarios across 12 tracks.**

POV coverage: DIRECT (1-4, 11), OBSERVED via corp ship (7), OBSERVED via garrison (8), OBSERVED sector-only (10.3), commander/manage (6, 9), terminal events (2.4, 2.5, 8.2, 12.1).

Headline-payoff evals (validate the new event-routing rework): 8.4 (cross-sector context query), 10.4 (per-viewer personalization), 3.4 (combat handoff), 1.5–1.7 (friendly safeguards).

Phase-2 sensitive: section 5 + scenario 3.1 (flee fields). Run pre/post-2.1 to capture regression baseline.

LLM-judge eval (semantic, not substring): 9.5.
