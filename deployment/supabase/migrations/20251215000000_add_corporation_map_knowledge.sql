-- Corporation Map Knowledge
-- Stores shared map knowledge for corporations, populated by corp ships

CREATE TABLE corporation_map_knowledge (
  corp_id UUID PRIMARY KEY REFERENCES corporations(corp_id) ON DELETE CASCADE,
  map_knowledge JSONB NOT NULL DEFAULT '{"sectors_visited": {}, "total_sectors_visited": 0}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER update_corporation_map_knowledge_updated_at
  BEFORE UPDATE ON corporation_map_knowledge
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE corporation_map_knowledge IS 'Shared map knowledge for corporations, populated by corp ship exploration';
COMMENT ON COLUMN corporation_map_knowledge.map_knowledge IS 'JSONB with same structure as characters.map_knowledge';

-- Update leaderboard_exploration view to include corp knowledge
DROP VIEW IF EXISTS leaderboard_exploration;
CREATE VIEW leaderboard_exploration AS
SELECT
  c.character_id,
  c.name,
  (c.map_knowledge->>'total_sectors_visited')::INTEGER AS sectors_visited,
  COALESCE(
    (c.map_knowledge->>'total_sectors_visited')::INTEGER, 0
  ) + COALESCE(
    (cmk.map_knowledge->>'total_sectors_visited')::INTEGER, 0
  ) - (
    -- Subtract overlap (sectors in both personal and corp)
    SELECT COUNT(*)::INTEGER FROM (
      SELECT jsonb_object_keys(COALESCE(c.map_knowledge->'sectors_visited', '{}'::jsonb))
      INTERSECT
      SELECT jsonb_object_keys(COALESCE(cmk.map_knowledge->'sectors_visited', '{}'::jsonb))
    ) overlap
  ) AS total_known_sectors,
  c.first_visit
FROM characters c
LEFT JOIN corporation_map_knowledge cmk ON cmk.corp_id = c.corporation_id
WHERE c.player_metadata->>'player_type' IS DISTINCT FROM 'corporation_ship'
ORDER BY sectors_visited DESC;
