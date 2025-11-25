-- Fix Universe Structure Column Types
-- Created: 2025-11-17
-- Purpose: Fix position columns from INTEGER to DOUBLE PRECISION to match universe-bang JSON format

-- ============================================================================
-- Fix Position Columns
-- ============================================================================

ALTER TABLE universe_structure
  ALTER COLUMN position_x TYPE DOUBLE PRECISION,
  ALTER COLUMN position_y TYPE DOUBLE PRECISION;

COMMENT ON COLUMN universe_structure.position_x IS 'Sector X coordinate (floating point from universe-bang)';
COMMENT ON COLUMN universe_structure.position_y IS 'Sector Y coordinate (floating point from universe-bang)';

-- Note: region column remains TEXT - loader will convert integer IDs to region names
COMMENT ON COLUMN universe_structure.region IS 'Region name (converted from region ID in JSON meta)';
