ALTER TABLE universe_structure ADD COLUMN IF NOT EXISTS name TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_universe_structure_name_lower ON universe_structure (LOWER(name));
