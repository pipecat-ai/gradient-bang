-- Remove observer_channels column (Realtime-only feature, no longer used)
ALTER TABLE sector_contents DROP COLUMN IF EXISTS observer_channels;
