ALTER TABLE sector_contents
  ADD COLUMN observer_channels JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN sector_contents.observer_channels IS 'List of observer channel identifiers for sector-level broadcasts';
