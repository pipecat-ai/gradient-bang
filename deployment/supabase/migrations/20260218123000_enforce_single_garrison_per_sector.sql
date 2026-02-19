-- Enforce "one garrison per sector" at the database layer and add owner FK.
-- This migration intentionally fails fast when existing data violates constraints.

DO $$
DECLARE
  duplicate_sectors INTEGER[];
  orphan_owner_ids UUID[];
BEGIN
  SELECT array_agg(sector_id ORDER BY sector_id)
  INTO duplicate_sectors
  FROM (
    SELECT g.sector_id
    FROM garrisons g
    GROUP BY g.sector_id
    HAVING COUNT(*) > 1
  ) duplicates;

  IF duplicate_sectors IS NOT NULL THEN
    RAISE EXCEPTION
      'cannot enforce one garrison per sector; duplicate sectors: %',
      duplicate_sectors
      USING ERRCODE = '23514';
  END IF;

  SELECT array_agg(owner_id ORDER BY owner_id)
  INTO orphan_owner_ids
  FROM (
    SELECT DISTINCT g.owner_id
    FROM garrisons g
    LEFT JOIN characters c ON c.character_id = g.owner_id
    WHERE c.character_id IS NULL
  ) orphans;

  IF orphan_owner_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'cannot add garrisons.owner_id FK; orphan owner_id values: %',
      orphan_owner_ids
      USING ERRCODE = '23503';
  END IF;
END;
$$;

ALTER TABLE garrisons
  ADD CONSTRAINT garrisons_owner_id_fkey
  FOREIGN KEY (owner_id) REFERENCES characters(character_id) ON DELETE CASCADE;

ALTER TABLE garrisons
  ADD CONSTRAINT garrisons_sector_unique UNIQUE (sector_id);
