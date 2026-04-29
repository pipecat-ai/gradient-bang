# Combat Phase 2 — Implementation Plan

Phase 1 (event-layer parity from [combat-events-catalog.md](combat-events-catalog.md)) is complete. This is what's left for full harness parity — engine-logic sync. Surgical edits to existing `_shared/combat_*.ts`. No schema migrations, no file moves. Source of truth: `client/combat-sim/src/engine/`.

---

## 2.1 — Per-payer toll *(primary work)*

**Today:** a toll payment ends combat globally. **Target:** payment is a peace contract scoped to one payer + one garrison; the payer stays in the encounter, other hostiles can still attack them, and combat only ends when every hostile has paid AND nobody is attacking.

**Already in place:** `processTollPayment` already writes per-payer rows to `entry.payments[]` ([combat_action/index.ts:656-668](../deployment/supabase/functions/combat_action/index.ts)). Schema is right; only the **read/decision logic** lags. `checkTollStanddown` still reads the legacy `entry.paid` global flag instead of scanning `payments[]`.

**Scenarios this fixes** (locked-in tests already in harness):

| # | Scenario | Today | Target |
|---|---|---|---|
| 1 | P1 pays, P2 braces | Combat ends — P2 free-rides | Continues; garrison escalates against P2 |
| 2 | P1 pays, P2 attacks P1 | P1 may get teleported out mid-fight | Garrison stands down vs P1; P2's attack still resolves |
| 3 | P1 pays twice | Accepted | Rejected — already at peace |
| 4 | P1 pays, then attacks the same garrison | Allowed | Rejected |

**Files:**

| File | Change |
|---|---|
| `_shared/combat_garrison.ts` | Add `allHostilesPaid`, `anyOutstandingToll`. Extend `selectStrongestTarget(..., paidPayers)` to exclude payers. Rewrite `buildTollAction` — re-pick target if sticky one paid; use `allHostilesPaid` (not `entry.paid`) for brace-vs-escalate. |
| `_shared/combat_resolution.ts` | Rewrite `checkTollStanddown` (currently at line 381) to scan `entry.payments[]` instead of `entry.paid`. Require all hostiles paid + no active attacks. Stalemate-unstuck calls `anyOutstandingToll`. |
| `combat_action/index.ts` | `processTollPayment` (line 556) rejects re-pay when caller already has a row in `entry.payments[]`. Attack branch rejects attacks against a garrison the actor has paid. |

No DB migration. The `entry.paid` / `entry.paid_round` legacy flags can stay (harmless coexistence) or be removed in a follow-up — not blocking.

**Reference:** [`engine.ts`](../client/combat-sim/src/engine/engine.ts), [`garrison.ts`](../client/combat-sim/src/engine/garrison.ts), [`combat.test.ts > toll garrison with multiple players (per-payer semantics)`](../client/combat-sim/src/engine/__tests__/combat.test.ts) — port the 5 assertions to `deployment/supabase/functions/tests/combat_test.ts`.

**Risk:** Visible game-mechanic change — players relying on the free-ride loophole will notice. Ship a release note. Hot deploy is safe (registry shape unchanged).

---

## 2.2 — Flee state surfacing

**Today:** `moveSuccessfulFleers` already exists ([combat_resolution.ts:448](../deployment/supabase/functions/_shared/combat_resolution.ts)) and moves the ship's `current_sector`. But it doesn't surface *why* the participant left the encounter — consumers can't distinguish 'destroyed' from 'fled'. The work is purely the surfacing layer on top of the existing move.

**Files:**

| File | Change |
|---|---|
| `_shared/combat_types.ts` | Add `has_fled?: boolean`, `fled_to_sector?: number \| null` to `CombatantState`. |
| `_shared/combat_resolution.ts` | Extend the existing `moveSuccessfulFleers` — write both fields onto the participant record before persistence. |
| `_shared/combat_events.ts` | Surface both fields in `buildParticipantPayload` alongside `fighters` / `destroyed` / `corp_id`. |

**Reference:** `engine.ts: moveSuccessfulFleers`, `types.ts`.

**Test:** A flees from sector X to Y. Assert both fields are present on the participant record and on the next `combat.round_resolved` payload.

**Risk:** Low. Additive only. No game-mechanic change.

---

## PR order

1. **2.2 (flee state)** — smallest, lands first. Three files, one test.
2. **2.1 (per-payer toll)** — largest behavioural change. Three files, five tests. Standalone, no dependency on PR 1.
