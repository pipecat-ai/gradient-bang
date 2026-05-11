-- Allow deleting a character to cascade-delete its context_snapshots rows.
-- Without this, eval_webhook seed resets fail on any character that has
-- accumulated debug snapshots from a prior run.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS makes re-runs a no-op net change.

ALTER TABLE context_snapshots
  DROP CONSTRAINT IF EXISTS context_snapshots_character_id_fkey;

ALTER TABLE context_snapshots
  ADD CONSTRAINT context_snapshots_character_id_fkey
  FOREIGN KEY (character_id) REFERENCES characters(character_id) ON DELETE CASCADE;
