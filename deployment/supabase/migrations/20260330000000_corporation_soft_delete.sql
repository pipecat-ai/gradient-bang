-- Corporation soft-delete migration
-- Instead of hard-deleting corporations on disband, we set disbanded_at.
-- This avoids FK constraint violations on the events table (corp_id, and
-- character_id for corp-ship pseudo-characters).

SET search_path = public;

-- 1. Add disbanded_at column
ALTER TABLE public.corporations
  ADD COLUMN IF NOT EXISTS disbanded_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN public.corporations.disbanded_at
  IS 'When the corporation was disbanded (soft-delete). NULL = active.';

-- 2. Replace the absolute unique-name index with a partial one so that
--    disbanded corporation names can be reused.
DROP INDEX IF EXISTS idx_corporations_name_lower;
CREATE UNIQUE INDEX idx_corporations_name_lower
  ON public.corporations (lower(name))
  WHERE disbanded_at IS NULL;

-- 3. Index for filtering active corporations efficiently
CREATE INDEX IF NOT EXISTS idx_corporations_active
  ON public.corporations (corp_id)
  WHERE disbanded_at IS NULL;
