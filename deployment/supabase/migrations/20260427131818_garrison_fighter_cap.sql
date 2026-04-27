-- Cap garrison fighter counts at 32,000 (Trade Wars 2002 precedent, originally
-- tied to int16 max). Mirrored in TypeScript at
-- _shared/garrison_transactions.ts:MAX_GARRISON_FIGHTERS — keep the two in sync
-- if the cap value changes.
--
-- Defensive belt-and-braces: the transaction layer in
-- runLeaveFightersTransaction is the primary enforcement point. This constraint
-- catches any code path that bypasses it (test seeders, future migrations,
-- manual SQL), failing with a constraint-violation error instead of silently
-- allowing unbounded accumulation.
--
-- If the constraint fails on deploy because production data already exceeds
-- 32k, replace `CHECK (...)` with `CHECK (...) NOT VALID` to apply only to new
-- and updated rows. The data audit is intentionally deferred — if any garrison
-- has accumulated past 32k, that's a finding worth investigating, not silently
-- grandfathering.
ALTER TABLE garrisons
  ADD CONSTRAINT garrisons_fighters_max_check
    CHECK (fighters <= 32000);
