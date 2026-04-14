-- Roll corporation-level stats into each corp member's leaderboard row
-- (option 1: full corp value added to every active member).
--
-- Wealth: every breakdown column (ship_credits, cargo_value, ship_value,
-- ships_owned) and total_wealth include personal + full corp ship totals.
-- Corp pseudo-chars (player_type = 'corporation_ship') are excluded from
-- the view so they don't self-reference.
--
-- Exploration: sectors_visited becomes |personal ∪ corp| (union — overlaps
-- counted once).
--
-- Territory and trading views are left unchanged (personal-only by design).

DROP VIEW IF EXISTS leaderboard_wealth;
CREATE VIEW leaderboard_wealth AS
WITH personal_ship_wealth AS (
  SELECT
    si.owner_id AS character_id,
    COUNT(*) AS ship_count,
    SUM(si.credits) AS total_ship_credits,
    SUM(si.cargo_qf * 100 + si.cargo_ro * 100 + si.cargo_ns * 100) AS total_cargo_value,
    SUM(sd.base_value) AS total_ship_value
  FROM ship_instances si
  JOIN ship_definitions sd ON si.ship_type = sd.ship_type
  WHERE NOT si.is_escape_pod
    AND si.owner_type IS DISTINCT FROM 'corporation'
  GROUP BY si.owner_id
),
corp_ship_wealth AS (
  SELECT
    si.owner_corporation_id AS corp_id,
    COUNT(*) AS corp_ship_count,
    SUM(si.credits) AS corp_ship_credits,
    SUM(si.cargo_qf * 100 + si.cargo_ro * 100 + si.cargo_ns * 100) AS corp_cargo_value,
    SUM(sd.base_value) AS corp_ship_value
  FROM ship_instances si
  JOIN ship_definitions sd ON si.ship_type = sd.ship_type
  WHERE NOT si.is_escape_pod
    AND si.owner_type = 'corporation'
    AND si.owner_corporation_id IS NOT NULL
  GROUP BY si.owner_corporation_id
)
SELECT
  c.character_id,
  c.name,
  CASE
    WHEN c.is_npc = TRUE THEN 'npc'
    ELSE 'human'
  END AS player_type,
  c.credits_in_megabank AS bank_credits,
  (COALESCE(psw.total_ship_credits, 0) + COALESCE(csw.corp_ship_credits, 0)) AS ship_credits,
  (COALESCE(psw.total_cargo_value, 0) + COALESCE(csw.corp_cargo_value, 0)) AS cargo_value,
  (COALESCE(psw.ship_count, 0) + COALESCE(csw.corp_ship_count, 0)) AS ships_owned,
  (COALESCE(psw.total_ship_value, 0) + COALESCE(csw.corp_ship_value, 0)) AS ship_value,
  (
    c.credits_in_megabank
    + COALESCE(psw.total_ship_credits, 0)
    + COALESCE(psw.total_cargo_value, 0)
    + COALESCE(psw.total_ship_value, 0)
    + COALESCE(csw.corp_ship_credits, 0)
    + COALESCE(csw.corp_cargo_value, 0)
    + COALESCE(csw.corp_ship_value, 0)
  ) AS total_wealth
FROM characters c
LEFT JOIN personal_ship_wealth psw ON psw.character_id = c.character_id
LEFT JOIN corp_ship_wealth csw ON csw.corp_id = c.corporation_id
WHERE c.player_metadata->>'player_type' IS DISTINCT FROM 'corporation_ship'
ORDER BY total_wealth DESC;

-- Exploration: expose personal ∪ corp as sectors_visited.
DROP VIEW IF EXISTS leaderboard_exploration;
CREATE VIEW leaderboard_exploration AS
SELECT
  c.character_id,
  c.name,
  CASE
    WHEN c.is_npc = TRUE THEN 'npc'
    ELSE 'human'
  END AS player_type,
  (
    COALESCE((c.map_knowledge->>'total_sectors_visited')::INTEGER, 0)
    + COALESCE((cmk.map_knowledge->>'total_sectors_visited')::INTEGER, 0)
    - (
      SELECT COUNT(*)::INTEGER FROM (
        SELECT jsonb_object_keys(COALESCE(c.map_knowledge->'sectors_visited', '{}'::jsonb))
        INTERSECT
        SELECT jsonb_object_keys(COALESCE(cmk.map_knowledge->'sectors_visited', '{}'::jsonb))
      ) overlap
    )
  ) AS sectors_visited,
  c.first_visit
FROM characters c
LEFT JOIN corporation_map_knowledge cmk ON cmk.corp_id = c.corporation_id
WHERE c.player_metadata->>'player_type' IS DISTINCT FROM 'corporation_ship'
ORDER BY sectors_visited DESC;
