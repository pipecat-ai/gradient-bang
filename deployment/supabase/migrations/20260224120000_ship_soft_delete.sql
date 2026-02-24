-- Add soft-delete support for ship destruction.
-- Instead of hard-deleting destroyed ships (which fails due to FK constraints
-- on events and port_transactions), we mark them with a destroyed_at timestamp.

ALTER TABLE ship_instances ADD COLUMN destroyed_at TIMESTAMPTZ DEFAULT NULL;

-- Recreate leaderboard_wealth to exclude destroyed ships
DROP VIEW IF EXISTS leaderboard_wealth;
CREATE VIEW leaderboard_wealth AS
SELECT
  c.character_id,
  c.name,
  CASE
    WHEN c.player_metadata->>'player_type' = 'corporation_ship' THEN 'corporation_ship'
    WHEN c.is_npc = TRUE THEN 'npc'
    ELSE 'human'
  END AS player_type,
  c.credits_in_megabank AS bank_credits,
  COALESCE(ship_wealth.total_ship_credits, 0) AS ship_credits,
  COALESCE(ship_wealth.total_cargo_value, 0) AS cargo_value,
  COALESCE(ship_wealth.ship_count, 0) AS ships_owned,
  COALESCE(ship_wealth.total_ship_value, 0) AS ship_value,
  (c.credits_in_megabank +
   COALESCE(ship_wealth.total_ship_credits, 0) +
   COALESCE(ship_wealth.total_cargo_value, 0) +
   COALESCE(ship_wealth.total_ship_value, 0)) AS total_wealth
FROM characters c
LEFT JOIN (
  SELECT
    si.owner_id,
    COUNT(*) AS ship_count,
    SUM(si.credits) AS total_ship_credits,
    SUM(si.cargo_qf * 100 + si.cargo_ro * 100 + si.cargo_ns * 100) AS total_cargo_value,
    SUM(sd.base_value) AS total_ship_value
  FROM ship_instances si
  JOIN ship_definitions sd ON si.ship_type = sd.ship_type
  WHERE NOT si.is_escape_pod
    AND si.destroyed_at IS NULL
  GROUP BY si.owner_id
) ship_wealth ON c.character_id = ship_wealth.owner_id
ORDER BY total_wealth DESC;
