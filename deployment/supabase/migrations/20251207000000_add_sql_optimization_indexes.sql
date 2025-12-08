-- =============================================================================
-- SQL Index Optimization Migration
-- Date: 2025-12-07
-- Description: Add missing indexes identified through edge function analysis
-- =============================================================================

-- High Priority Indexes
-- ---------------------------------------------------------------------------

-- 1. Corporation members active membership indexes
-- Used by: corporation_join, corporation_leave, combat_initiate,
--          combat_collect_fighters, pgEnsureActorCanControlShip, etc.
CREATE INDEX IF NOT EXISTS idx_corporation_members_active_char
ON corporation_members(character_id)
WHERE left_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_corporation_members_active_corp
ON corporation_members(corp_id)
WHERE left_at IS NULL;

-- 2. Characters by corporation
-- Used by: pgLoadGarrisonContext, pgEmitMovementObservers
CREATE INDEX IF NOT EXISTS idx_characters_corporation
ON characters(corporation_id)
WHERE corporation_id IS NOT NULL;

-- 3. Combat deadline queries (for combat_tick cron)
-- Used by: listDueCombats, combat_tick
CREATE INDEX IF NOT EXISTS idx_sector_contents_combat_deadline
ON sector_contents ((combat->>'deadline'))
WHERE combat IS NOT NULL;

-- 4. Active garrisons
-- Used by: pgCheckGarrisonAutoEngage, combat_collect_fighters
CREATE INDEX IF NOT EXISTS idx_garrisons_sector_active
ON garrisons(sector_id)
WHERE fighters > 0;

-- Medium Priority Indexes
-- ---------------------------------------------------------------------------

-- 5. Combat ID lookup
-- Used by: loadCombatById
CREATE INDEX IF NOT EXISTS idx_sector_contents_combat_id
ON sector_contents ((combat->>'combat_id'))
WHERE combat IS NOT NULL;

-- 6. Events ascending order for events_since
-- Used by: fetchEventsForCharacter
CREATE INDEX IF NOT EXISTS idx_event_character_recipients_char_event_asc
ON event_character_recipients(character_id, event_id ASC);
