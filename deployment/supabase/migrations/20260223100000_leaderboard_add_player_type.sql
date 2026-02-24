-- Add player_type to all leaderboard views so the client can filter
-- by human / npc / corporation_ship.

-- Wealth leaderboard
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
  GROUP BY si.owner_id
) ship_wealth ON c.character_id = ship_wealth.owner_id
ORDER BY total_wealth DESC;

-- Territory leaderboard
DROP VIEW IF EXISTS leaderboard_territory;
CREATE VIEW leaderboard_territory AS
SELECT
  c.character_id,
  c.name,
  CASE
    WHEN c.player_metadata->>'player_type' = 'corporation_ship' THEN 'corporation_ship'
    WHEN c.is_npc = TRUE THEN 'npc'
    ELSE 'human'
  END AS player_type,
  COUNT(DISTINCT g.sector_id) AS sectors_controlled,
  SUM(g.fighters) AS total_fighters_deployed,
  SUM(g.toll_balance) AS total_toll_collected
FROM characters c
JOIN garrisons g ON c.character_id = g.owner_id
GROUP BY c.character_id, c.name, c.player_metadata, c.is_npc
ORDER BY sectors_controlled DESC, total_fighters_deployed DESC;

-- Trading leaderboard
DROP VIEW IF EXISTS leaderboard_trading;
CREATE VIEW leaderboard_trading AS
SELECT
  c.character_id,
  c.name,
  CASE
    WHEN c.player_metadata->>'player_type' = 'corporation_ship' THEN 'corporation_ship'
    WHEN c.is_npc = TRUE THEN 'npc'
    ELSE 'human'
  END AS player_type,
  COUNT(*) AS total_trades,
  SUM(pt.total_price) AS total_trade_volume,
  COUNT(DISTINCT pt.sector_id) AS ports_visited
FROM characters c
JOIN port_transactions pt ON c.character_id = pt.character_id
WHERE pt.created_at > NOW() - INTERVAL '7 days'
GROUP BY c.character_id, c.name, c.player_metadata, c.is_npc
ORDER BY total_trade_volume DESC;

-- Exploration leaderboard
DROP VIEW IF EXISTS leaderboard_exploration;
CREATE VIEW leaderboard_exploration AS
SELECT
  c.character_id,
  c.name,
  CASE
    WHEN c.player_metadata->>'player_type' = 'corporation_ship' THEN 'corporation_ship'
    WHEN c.is_npc = TRUE THEN 'npc'
    ELSE 'human'
  END AS player_type,
  (c.map_knowledge->>'total_sectors_visited')::INTEGER AS sectors_visited,
  COALESCE(
    (c.map_knowledge->>'total_sectors_visited')::INTEGER, 0
  ) + COALESCE(
    (cmk.map_knowledge->>'total_sectors_visited')::INTEGER, 0
  ) - (
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
