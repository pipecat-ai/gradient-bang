# Combat Migration — Phase 1 & Phase 2 Plan

## Framing

The combat-sim harness (`client/combat-sim/`) has evolved a handful of behavioural and event-shape improvements over the production engine. This plan brings production to **functional parity** with the harness.

### What this migration IS

- A **surgical, in-place sync** of production's existing `_shared/combat_*.ts` files so they behave, emit, and route events identically to the harness engine.
- Harness = source of truth. Every net-new rule or event in this plan already exists, tested, in `client/combat-sim/`.

### What this migration is NOT

- **Not a swap.** The legacy engine stays in place. No `git mv` to `_legacy_combat/`, no copy of harness `engine.ts` into `_shared/combat/`, no atomic replacement PR. This supersedes the "Migrating back to production" section of [combat-debug-harness-spec.md](combat-debug-harness-spec.md), which described a swap approach.
- **Not a port of harness-only debug features.** Anything the harness added purely for observability or composition (see "Explicitly excluded" below) stays in the harness.

### Principle

> Production and harness should emit the same events, with the same payload shapes, to the same recipients, with the same combat-logic outcomes. Debug ergonomics (staging, timer toggle, world reset, forced ending) are harness-only and don't belong in production.

---

## Phase 1 — Event-layer parity

**Ownership:** [combat-event-parity-spec.md](combat-event-parity-spec.md) already enumerates this work in full — Surfaces A through I plus Adjacent engine fix 1. Phase 1 is shorthand for "land every PR in that spec's rollout."

Summary of what Phase 1 delivers:

| Surface | Change |
|---|---|
| A | New `garrison.destroyed` event emitted before row delete |
| B | Absent garrison owners + their corp receive round events (silent append) |
| C | New `InferenceRule.OWNED` rule category in `event_relay.py` |
| D | Garrison envelope XML attrs (`garrison_id`, `garrison_owner`) |
| E | Participant payload gains `fighters`, `destroyed`, `corp_id` |
| F | Garrison payload gains `owner_character_id`, `owner_corp_id` |
| G | `ship.destroyed` payload gains `owner_character_id`, `corp_id` |
| H | `ship.destroyed` inference rule: `NEVER` → `OWNED` (voice fires for owner) |
| I | `combat.md` prompt references the new fields |

All additive on the server side. No schema migrations. No file moves. See the parity spec for payload shapes, dependencies, PR ordering, and tests.

---

## Phase 2 — Engine logic sync

Phase 2 is the set of behavioural gaps between the legacy engine and the harness that are **not** event-shape changes. These land as surgical edits to existing `_shared/combat_*.ts` files — no file reorganization.

### 2.1 — Per-payer toll semantics *(primary work item)*

**Already documented** in [combat-event-parity-spec.md](combat-event-parity-spec.md) under "Adjacent engine fixes → Engine fix 1." Restated here so Phase 2 is self-contained.

**Behavioural gap.** Legacy treats a toll payment as a global "combat ends for everyone" gate. Harness treats it as a **peace contract with one garrison, scoped to the payer**:
- Payment is deducted, recorded as `{ payer, amount, round }` on the garrison's `toll_registry` entry.
- The garrison cannot target that payer; the payer cannot target that garrison.
- The payer stays in the encounter — other hostiles may still attack them.
- Combat ends `toll_satisfied` only when *every* non-friendly hostile has a payment on record AND nobody is actively attacking.

**Scenarios this fixes:**
| # | Scenario | Legacy behaviour | Target behaviour |
|---|---|---|---|
| 1 | P1 pays, P2 braces | Combat ends — P2 free-rides | Combat continues; garrison escalates against P2 next round |
| 2 | P1 pays, P2 attacks P1 | P1 may get teleported out mid-fight | Garrison stands down vs P1; P2's attack still resolves; P1 takes damage |
| 3 | P1 pays twice | Second payment accepted | Second payment rejected ("already paid, you are at peace with this garrison") |
| 4 | P1 pays then attacks the garrison they paid | Allowed | Rejected ("already paid toll to X; cannot attack a garrison you are at peace with") |

**Files to edit (legacy):**
| File | Change |
|---|---|
| `_shared/combat_garrison.ts` | Add `allHostilesPaid(encounter, garrison, entry, corps)` and `anyOutstandingToll(encounter, registry, corps)`. Extend `selectStrongestTarget(..., paidPayers)` to exclude payers. Rewrite `buildTollAction` to re-pick `entry.target_id` if the sticky target has paid, and use `allHostilesPaid` (not `entry.paid`) for brace-vs-escalate. |
| `_shared/combat_resolution.ts` | Rewrite `checkTollStanddown` to require all hostiles paid + no active attacks. Update stalemate-unstuck path to call `anyOutstandingToll`. |
| `combat_action/index.ts` | Reject re-pay in `processTollPayment` when a payment record already exists for the caller. Reject attacks against a garrison the actor has already paid. |

**Schema note.** `toll_registry.payments: Array<{ payer, amount, round }>` is already correct in production — `processTollPayment` writes per-payer rows today. Only the *read/decision logic* needs updating. No DB migration.

**Reference implementation (harness, already landed + tested):**
- [`engine.ts`](../client/combat-sim/src/engine/engine.ts) — `processTollPayment`, attack-branch validation
- [`garrison.ts`](../client/combat-sim/src/engine/garrison.ts) — `allHostilesPaid`, `anyOutstandingToll`, `selectStrongestTarget`, `buildTollAction`
- [`combat.test.ts > toll garrison with multiple players (per-payer semantics)`](../client/combat-sim/src/engine/__tests__/combat.test.ts) — 5 locked-in scenarios

**Test port.** Mirror the 5 harness scenarios in [`combat_test.ts`](../deployment/supabase/functions/tests/combat_test.ts).

**Risk.** Medium. Observable game-mechanic change — non-payers no longer free-ride. Call out in release notes.

---

### 2.2 — Explicit `has_fled` / `fled_to_sector` on participants

**Behavioural gap.** Harness surfaces `has_fled: boolean` and `fled_to_sector: number | null` as explicit fields on `CombatantState` after a successful flee. Legacy reconstructs this from the round's `flee_results` log retroactively. Consumers (UI, agent context, summary tools) currently infer flee state by scanning event history; harness gives them a direct read.

**Reference:** [`types.ts`](../client/combat-sim/src/engine/types.ts) — `CombatantState.has_fled`, `fled_to_sector`. Set at [`engine.ts`](../client/combat-sim/src/engine/engine.ts) `moveSuccessfulFleers`.

**Files to edit (legacy):**
| File | Change |
|---|---|
| `_shared/combat_types.ts` | Add `has_fled?: boolean`, `fled_to_sector?: number \| null` to the participant state type. |
| `_shared/combat_resolution.ts` | Wherever successful flee is processed (mirror harness `moveSuccessfulFleers`), write both fields onto the participant record before persistence. |
| `_shared/combat_events.ts` | Surface `has_fled` / `fled_to_sector` in `buildParticipant` alongside the Surface E fields (`fighters`, `destroyed`, `corp_id`). |

**Risk.** Low. Additive state + payload field. Web client is field-tolerant.

**Coupling.** Land alongside Surface E (Phase 1) or right after. Same payload surface.

---

### 2.3 — Other subtle logic divergences

The harness audit surfaced no other behavioural gaps beyond per-payer toll + flee-state surfacing. Round-resolution math (damage, shields, hit chance, mitigation), demand-round stand-down, initiator-preference target selection, and end-state detection are already behaviourally identical between the two engines. Items the legacy engine carries that the harness omits (e.g. `CombatRoundOutcome.participant_deltas`) are not observably wrong — they're redundant, not divergent — and stay.

If a later audit surfaces more, they're added here as 2.4, 2.5, … No surprise items hidden in Phase 2 beyond what's listed above.

---

## Explicitly excluded

Harness-only features that exist purely for debug / observability / composition UX. **These do not port to production.**

| Feature | Harness location | Why harness-only |
|---|---|---|
| `stagingMode` flag + `setStagingMode()` | `engine.ts:117-127` | Suppresses auto-engage/auto-initiate during arena composition. Production has no composition phase — combat starts when the rules say so. |
| `runScenario()` | `engine.ts:152-187` | Manual 3-pass kickoff used to "commit" a staged scenario. No production equivalent. |
| Timer toggle + `harness.timer_toggled` event + `setTimerEnabled()` | `engine.ts:189-212` | Pauses round deadlines for debugging. Production rounds always have real-time deadlines driven by cron. |
| `world.reset` event + `resetWorld()` | `engine.ts:220-226` | Wipes harness state to a clean slate. Production state is managed via normal RPC boundaries — no equivalent. |
| `forceEndCombat()` | `engine.ts:1002-1078` | Escape hatch to unstick a hung encounter. Production relies on natural resolution + cron-driven stalemate unstuck. |
| Harness UI features (ScenarioBuilder, EntityRoster, fly-away counters, SummarizeModal, controller picker, decision trace, progress bars, POV filter, staging badge, API-key gate) | `client/combat-sim/src/components/**` + `src/controllers/**` + `src/agent/**` | Developer instrument. None of it belongs in the production client. |
| `MockEventRelay` wrapping `InMemoryEmitter` | `client/combat-sim/src/relay/event_relay.ts` | Harness simulation of the Python EventRelay so we can test routing in-browser. Production uses the real `event_relay.py`. |

If a specific harness debug primitive looks genuinely useful for production admin tooling (e.g. a force-end-combat admin RPC for oncall), that's a separate feature request — not part of this migration.

---

## Migration approach

**In-place, surgical, additive.** Each Phase 1 surface and each Phase 2 item lands as its own PR against existing files. No file moves, no parallel-engine feature flag, no swap moment.

**Ordering:**
1. Phase 1 ships per the parity spec's PR rollout (PRs 1–9, with the ordering constraints C→A, F→D, C+G→H, D+E+F+G+H→I).
2. Phase 2.1 (per-payer toll) is the parity spec's PR 7 — ship it whenever, independent of other Phase 1 PRs.
3. Phase 2.2 (flee-state surfacing) is an additive payload + state field — ship alongside or after Phase 1's Surface E.

**Source of truth going forward.** Behavioural changes to combat land in the harness first (with tests), then port surgically to production via this plan's pattern. The parity spec is a living doc — re-audit before each PR to catch harness drift.

---

## Verification

Per-surface / per-item tests land with each PR (covered in the parity spec for Phase 1; mirrored from `client/combat-sim/src/engine/__tests__/` for Phase 2).

**Shared, one-shot checks around the full landing** (borrowed from the parity spec):

1. **Fixture-diff pass.** Run 5–6 canonical scenarios against *pre-migration* production, capture event sequences to `deployment/supabase/functions/tests/fixtures/combat_event_parity/`. Re-run post-migration. Diff `{type, payload keys, recipient set}`. Every diff must map to a surface/item in this plan.
   - 1v1 character combat
   - Character + corp ship vs. 2-character opposition
   - Toll-mode garrison with paying participant (validates 2.1)
   - Defensive garrison + absent owner (validates Surface B)
   - Garrison destruction (validates Surface A)
   - Character vs. enemy corp ship with corp-member observers (validates corp_id propagation)
   - Successful flee (validates 2.2)

2. **Integration suites.**
   - `bash deployment/supabase/functions/tests/run_tests.sh` — per-surface assertions + ported harness scenarios
   - `bash scripts/run-integration-tests.sh` — bot-side routing correctness (`InferenceRule.OWNED` fires only for owner; absent-owner round events silent-append)

3. **Manual end-to-end.** Local bot + local Supabase + production client. Scripted in the parity spec's "Manual end-to-end" section.

---

## Risks

1. **Harness drift during rollout.** The harness keeps evolving; new diffs could surface mid-migration. Mitigation: re-run the diff audit before each Phase 2 PR.
2. **Test debt.** Some harness tests (e.g. `agent.test.ts`) exercise routing via `MockEventRelay`, not real `event_relay.py`. Port assertions carefully — the rules must match but the harness wrapper doesn't.
3. **Release-note coverage for 2.1.** Per-payer toll is a visible game-mechanic change; ship the release note the same day.
4. **Inherited risks from the parity spec.** Privacy audit on new IDs (Surfaces E/F/G), recipient-set growth (Surface B), payload-size creep — all catalogued in [combat-event-parity-spec.md](combat-event-parity-spec.md) "Risks." Don't re-enumerate here.

---

## Critical files

**Phase 1** — see [combat-event-parity-spec.md](combat-event-parity-spec.md) "Critical files."

**Phase 2:**
- `deployment/supabase/functions/_shared/combat_garrison.ts` — per-payer toll helpers (2.1)
- `deployment/supabase/functions/_shared/combat_resolution.ts` — stand-down + stalemate logic (2.1); flee-state writes (2.2)
- `deployment/supabase/functions/combat_action/index.ts` — re-pay + attack-after-pay rejections (2.1)
- `deployment/supabase/functions/_shared/combat_types.ts` — add `has_fled`, `fled_to_sector` (2.2)
- `deployment/supabase/functions/_shared/combat_events.ts` — surface flee fields on participants (2.2)
- `deployment/supabase/functions/tests/combat_test.ts` — per-payer toll scenarios, flee-state assertions

**Reference (read-only):**
- `client/combat-sim/src/engine/engine.ts` — canonical behaviour
- `client/combat-sim/src/engine/garrison.ts` — per-payer toll reference
- `client/combat-sim/src/engine/types.ts` — canonical participant state
- `client/combat-sim/src/engine/__tests__/combat.test.ts` — locked-in test scenarios
- [combat-event-parity-spec.md](combat-event-parity-spec.md) — Phase 1 detail
- [combat-debug-harness-spec.md](combat-debug-harness-spec.md) — harness design reference (migration section superseded by this plan)
