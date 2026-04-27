# Garrison Fighter Cap — Technical Plan

## Goal

Cap the maximum fighter count for a single garrison so a player (or corp) can't accumulate unbounded forces in one sector. Mirrors the Trade Wars precedent (~32k per sector) — a high but hard ceiling that creates strategic chokepoint dynamics without being trivially reachable.

---

## Cap value

**Locked: `MAX_GARRISON_FIGHTERS = 32_000`**

Rationale:
- Matches the Trade Wars 2002 sector-fighter cap (32k, tied to int16 max).
- Comfortably below int4 max, so no overflow risk in `garrisons.fighters` (already `INTEGER NOT NULL`).
- High enough that hitting it is a deliberate late-game move, not an early-game blocker.

Where to define: a single export in `_shared/garrison_transactions.ts` (or a new `_shared/garrison_constants.ts` if other limits accrete). Use it everywhere — no magic numbers.

**Note on per-sector vs. per-garrison.** Today the codebase enforces "one garrison per sector" at deploy time ([garrison_transactions.ts:157, 190](../deployment/supabase/functions/_shared/garrison_transactions.ts)). So the per-garrison cap is effectively a per-sector cap — no separate sum-across-garrisons logic needed.

---

## Enforcement points

Three layers, ordered cheapest → strongest:

### 1. Edge function pre-validation — `combat_leave_fighters/index.ts`

Before kicking off the transaction, look up the current garrison's fighter count (if any) and reject early with a 400 if `existing.fighters + quantity > MAX_GARRISON_FIGHTERS`. Friendly error path: clean message, no lock contention, no rollback log noise.

This is best-effort; it can race against a concurrent deploy. The transaction layer is the source of truth.

### 2. Transaction-layer check — `_shared/garrison_transactions.ts:runLeaveFightersTransaction`

The authoritative check. After locking the garrison row(s) and reading the current `fighters` value, verify the post-write count would not exceed the cap. Two branches need it:

- **INSERT new garrison** (line 291): `quantity > MAX_GARRISON_FIGHTERS` → reject.
- **UPDATE existing garrison** (lines 250, 265 — owner and corp-mate reinforce paths): `existing.fighters + quantity > MAX_GARRISON_FIGHTERS` → reject.

Throw `buildStatusError(message, 400)` on violation — same pattern as existing "insufficient fighters" rejection at line 222.

### 3. DB CHECK constraint *(optional belt-and-braces)*

Add via migration:

```sql
ALTER TABLE garrisons
  ADD CONSTRAINT garrisons_fighters_max_check
    CHECK (fighters <= 32000);
```

Cheap, catches any code path that might bypass `garrison_transactions.ts` (test seeders, future migrations, manual SQL). Failure mode: 500 from the transaction with a constraint-violation error message — uglier UX than the layer-2 check, but defense-in-depth against drift.

---

## Error semantics

**Locked: reject.** When `quantity` would push the garrison over `MAX_GARRISON_FIGHTERS`, reject the entire request with a 400 and a message that includes the maximum additional quantity allowed:

```
"Garrison would exceed maximum of 32000 fighters; max additional = N"
```

Matches existing rejection patterns (insufficient credits, rate limit, ship-not-in-sector). Voice agent can read the `max additional = N` count off the error and relay it to the player without further computation.

No clamp — no partial deploys. The player's ship retains all requested fighters; nothing moves on rejection.

---

## Files to edit

| File | Change |
|---|---|
| `_shared/garrison_transactions.ts` | Add `export const MAX_GARRISON_FIGHTERS = 32_000;`. Add cap check in both INSERT and UPDATE branches of `runLeaveFightersTransaction`. Throw `buildStatusError("...max additional = N", 400)` on violation. |
| `combat_leave_fighters/index.ts` | Pre-validate against cap before transaction (best-effort). Surface clean error. |
| `deployment/supabase/migrations/<new>_garrison_fighter_cap.sql` | Add CHECK constraint (optional but recommended). |
| `_shared/garrison_transactions.test.ts` | New test cases (see below). |

No client or bot-side changes needed — the existing error-surface pipeline carries the rejection through.

---

## Pre-deploy data audit

Skipped for now — game is early enough that no garrison is realistically above 32k. If the migration's CHECK constraint fails on deploy, fall back to `CHECK (fighters <= 32000) NOT VALID` (applies to new/updated rows only, leaves existing intact).

---

## Tests

Add to `_shared/garrison_transactions.test.ts`:

1. **Deploy below cap → success.** Existing 1000, deploy 100, end at 1100.
2. **Deploy exactly at cap → success.** Existing 31900, deploy 100, end at 32000.
3. **Deploy that would exceed → rejected with clean error.** Existing 31900, deploy 200 → 400 error mentioning max additional = 100.
4. **Insert at cap → success.** New garrison, deploy exactly 32000.
5. **Insert that would exceed → rejected.** New garrison, deploy 32001 → 400.
6. **Corp-mate reinforce respects cap.** Existing 31900 (owner P1), corp-mate P3 deploys 200 → rejected.
7. **Combat damage reopens headroom.** Existing 31900, garrison takes 1000 damage → 30900, deploy 1500 → success.

Edge function integration test in `combat_test.ts` for path 3 — confirms 400 + error message round-trips through the edge function.

---

## Risk

**Low.**

- Additive constraint — no existing flow breaks unless it was relying on unbounded fighter counts.
- The pre-deploy data audit covers the existing-data risk.
- No game-mechanic change beyond the new ceiling. Players who haven't approached the cap won't notice.
- Voice agent UX: the rejection message is just one more variant of "deploy failed, here's why" — same pattern as insufficient fighters or insufficient credits.

**One thing to flag**: if Trade Wars-style "fortified chokepoint" is a desired late-game dynamic, 32k might still be approachable for whales. Consider raising to `100_000` if the design wants the cap to be effectively unreachable for years of play. Or lowering (e.g. `10_000`) if the design wants the chokepoint to be reachable mid-game and be a real strategic moment.

---

## Out of scope

- Per-sector caps that sum across multiple garrisons (not applicable — system already enforces one garrison per sector).
- Caps on ship fighter capacity (separate concept, already handled by `ship_definitions.fighters` per ship type).
- Caps on toll balance accumulation (`toll_balance` already has `>= 0` check; no upper cap today — different track).
- Dynamic caps based on sector type, owner level, or corp size — keep it simple, single constant.
