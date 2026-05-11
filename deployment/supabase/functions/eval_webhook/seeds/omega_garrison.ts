// Omega Garrison Eval — non-corp character set up for multi-turn garrison/fighter scenarios.
//   Eval0 — at mega-port, 10000 credits, 0 fighters       (Buy Fighters)
//   Eval1 — at non-Fed sector, 100 fighters on ship       (Place Garrison + Set Mode)
//   Eval2 — at non-Fed sector + own 50-fighter garrison in same sector (Collect)
//   Eval3 — at sector 0 (Fed Space) + remote 50-fighter garrison in toll mode (Change Mode)
//   Eval4 — at non-Fed sector + own 50-fighter garrison in same sector (Disband)
// Seeds 5 variations linked to one shared omega eval auth user (within the 5-character cap).
// Universe-agnostic: the mega-port and non-Fed garrison sectors are looked up dynamically
// at seed time from `universe_config.meta` and `universe_structure`.
// Usage: psql $LOCAL_API_POSTGRES_URL -f seeds/omega_garrison.sql
export const sql = `
BEGIN;

-- ── TEARDOWN ──────────────────────────────────────────────────────────
DELETE FROM garrisons WHERE owner_id IN (
  '60000000-0000-4000-8000-000000000008',
  '60000000-1000-4000-8000-000000000008',
  '60000000-2000-4000-8000-000000000008',
  '60000000-3000-4000-8000-000000000008',
  '60000000-4000-4000-8000-000000000008'
);
DELETE FROM events WHERE character_id IN (
  '60000000-0000-4000-8000-000000000008',
  '60000000-1000-4000-8000-000000000008',
  '60000000-2000-4000-8000-000000000008',
  '60000000-3000-4000-8000-000000000008',
  '60000000-4000-4000-8000-000000000008'
);
DELETE FROM events WHERE sender_id IN (
  '60000000-0000-4000-8000-000000000008',
  '60000000-1000-4000-8000-000000000008',
  '60000000-2000-4000-8000-000000000008',
  '60000000-3000-4000-8000-000000000008',
  '60000000-4000-4000-8000-000000000008'
);
DELETE FROM events WHERE ship_id IN (
  SELECT ship_id FROM ship_instances WHERE owner_character_id IN (
    '60000000-0000-4000-8000-000000000008',
    '60000000-1000-4000-8000-000000000008',
    '60000000-2000-4000-8000-000000000008',
    '60000000-3000-4000-8000-000000000008',
    '60000000-4000-4000-8000-000000000008'
  )
);

DELETE FROM user_characters WHERE character_id IN (
  '60000000-0000-4000-8000-000000000008',
  '60000000-1000-4000-8000-000000000008',
  '60000000-2000-4000-8000-000000000008',
  '60000000-3000-4000-8000-000000000008',
  '60000000-4000-4000-8000-000000000008'
);

UPDATE characters SET current_ship_id = NULL WHERE character_id IN (
  '60000000-0000-4000-8000-000000000008',
  '60000000-1000-4000-8000-000000000008',
  '60000000-2000-4000-8000-000000000008',
  '60000000-3000-4000-8000-000000000008',
  '60000000-4000-4000-8000-000000000008'
);

DELETE FROM ship_instances WHERE owner_character_id IN (
  '60000000-0000-4000-8000-000000000008',
  '60000000-1000-4000-8000-000000000008',
  '60000000-2000-4000-8000-000000000008',
  '60000000-3000-4000-8000-000000000008',
  '60000000-4000-4000-8000-000000000008'
);

DELETE FROM characters WHERE character_id IN (
  '60000000-0000-4000-8000-000000000008',
  '60000000-1000-4000-8000-000000000008',
  '60000000-2000-4000-8000-000000000008',
  '60000000-3000-4000-8000-000000000008',
  '60000000-4000-4000-8000-000000000008'
);

-- ── SEED ──────────────────────────────────────────────────────────────
-- Shared omega eval auth user (idempotent — re-running is safe).
INSERT INTO auth.users (id, email, aud, role, is_sso_user, is_anonymous) VALUES
  ('60000000-0000-4aaa-8000-000000000008', 'omega-eval@gradientbang.com', 'authenticated', 'authenticated', false, false)
ON CONFLICT (id) DO NOTHING;

-- Characters with placeholder map_knowledge (overwritten by the dynamic block below).
INSERT INTO characters (character_id, name, credits_in_megabank, map_knowledge) VALUES
  ('60000000-0000-4000-8000-000000000008', 'Omega Garrison Eval0', 5000, '{"total_sectors_visited": 0, "sectors_visited": {}}'),
  ('60000000-1000-4000-8000-000000000008', 'Omega Garrison Eval1', 5000, '{"total_sectors_visited": 0, "sectors_visited": {}}'),
  ('60000000-2000-4000-8000-000000000008', 'Omega Garrison Eval2', 5000, '{"total_sectors_visited": 0, "sectors_visited": {}}'),
  ('60000000-3000-4000-8000-000000000008', 'Omega Garrison Eval3', 5000, '{"total_sectors_visited": 0, "sectors_visited": {}}'),
  ('60000000-4000-4000-8000-000000000008', 'Omega Garrison Eval4', 5000, '{"total_sectors_visited": 0, "sectors_visited": {}}');

-- Personal ship: kestrel_courier each.
-- Eval0 — 10000 credits, 0 fighters (will buy fighters at the mega-port).
-- Eval1 — 3000  credits, 100 fighters on ship (will place a garrison).
-- Eval2 — 3000  credits, 0 fighters (will collect fighters from a garrison).
-- Eval3 — 3000  credits, 0 fighters (will change a remote garrison's mode).
-- Eval4 — 3000  credits, 0 fighters (will disband a garrison).
-- current_sector starts at 0; the dynamic block below moves Eval0/1/2/4 to the correct sectors.
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES
  ('60000000-0000-4000-8000-f00000000001', '60000000-0000-4000-8000-000000000008', 'character', '60000000-0000-4000-8000-000000000008', 'kestrel_courier', 0, 10000, 300, 150, 0),
  ('60000000-1000-4000-8000-f00000000001', '60000000-1000-4000-8000-000000000008', 'character', '60000000-1000-4000-8000-000000000008', 'kestrel_courier', 0, 3000, 300, 150, 100),
  ('60000000-2000-4000-8000-f00000000001', '60000000-2000-4000-8000-000000000008', 'character', '60000000-2000-4000-8000-000000000008', 'kestrel_courier', 0, 3000, 300, 150, 0),
  ('60000000-3000-4000-8000-f00000000001', '60000000-3000-4000-8000-000000000008', 'character', '60000000-3000-4000-8000-000000000008', 'kestrel_courier', 0, 3000, 300, 150, 0),
  ('60000000-4000-4000-8000-f00000000001', '60000000-4000-4000-8000-000000000008', 'character', '60000000-4000-4000-8000-000000000008', 'kestrel_courier', 0, 3000, 300, 150, 0);

-- Set active personal ship.
UPDATE characters SET current_ship_id = '60000000-0000-4000-8000-f00000000001' WHERE character_id = '60000000-0000-4000-8000-000000000008';
UPDATE characters SET current_ship_id = '60000000-1000-4000-8000-f00000000001' WHERE character_id = '60000000-1000-4000-8000-000000000008';
UPDATE characters SET current_ship_id = '60000000-2000-4000-8000-f00000000001' WHERE character_id = '60000000-2000-4000-8000-000000000008';
UPDATE characters SET current_ship_id = '60000000-3000-4000-8000-f00000000001' WHERE character_id = '60000000-3000-4000-8000-000000000008';
UPDATE characters SET current_ship_id = '60000000-4000-4000-8000-f00000000001' WHERE character_id = '60000000-4000-4000-8000-000000000008';

-- All 5 slots linked to the shared omega eval auth user (exactly at the 5-character cap).
INSERT INTO user_characters (user_id, character_id) VALUES
  ('60000000-0000-4aaa-8000-000000000008', '60000000-0000-4000-8000-000000000008'),
  ('60000000-0000-4aaa-8000-000000000008', '60000000-1000-4000-8000-000000000008'),
  ('60000000-0000-4aaa-8000-000000000008', '60000000-2000-4000-8000-000000000008'),
  ('60000000-0000-4aaa-8000-000000000008', '60000000-3000-4000-8000-000000000008'),
  ('60000000-0000-4aaa-8000-000000000008', '60000000-4000-4000-8000-000000000008');

-- ── DYNAMIC SECTOR ASSIGNMENT ─────────────────────────────────────────
-- Look up the universe's mega-port and pick non-Fed sectors at depths 2 and 4
-- via BFS over universe_structure.warps. Then:
--   - move Eval0's ship to the mega-port,
--   - move Eval1/2/4's ships to the close non-Fed sector,
--   - leave Eval3 at sector 0 (its garrison is remote),
--   - create the three garrisons,
--   - populate map_knowledge with the three key sectors so list_known_ports / plot_course resolve.
DO $omega_garrison$
DECLARE
  v_mega_port      INT;
  v_close_non_fed  INT;
  v_remote_non_fed INT;
  v_mp_adj         JSONB;
  v_mp_pos         JSONB;
  v_close_adj      JSONB;
  v_close_pos      JSONB;
  v_remote_adj     JSONB;
  v_remote_pos     JSONB;
  v_char_ids UUID[] := ARRAY[
    '60000000-0000-4000-8000-000000000008'::uuid,
    '60000000-1000-4000-8000-000000000008'::uuid,
    '60000000-2000-4000-8000-000000000008'::uuid,
    '60000000-3000-4000-8000-000000000008'::uuid,
    '60000000-4000-4000-8000-000000000008'::uuid
  ];
BEGIN
  -- Mega-port lookup (matches sigma_fleet pattern).
  SELECT (meta->'mega_port_sectors'->>0)::int INTO v_mega_port
    FROM universe_config WHERE id = 1;
  IF v_mega_port IS NULL THEN
    RAISE NOTICE 'omega_garrison: no mega-port configured; skipping dynamic sector assignment.';
    RETURN;
  END IF;

  -- Close non-Fed sector: shallowest sector at depth >= 2 from the mega-port whose
  -- region is NOT 'Federation Space'. Depth >= 2 also rules out border sectors
  -- (Neutral sectors directly adjacent to Fed Space), which place_fighters forbids.
  WITH RECURSIVE bfs AS (
    SELECT v_mega_port AS sector_id, 0 AS depth, ARRAY[v_mega_port] AS path
    UNION ALL
    SELECT (w->>'to')::int, b.depth + 1, b.path || (w->>'to')::int
    FROM bfs b
    JOIN universe_structure us ON us.sector_id = b.sector_id
    CROSS JOIN jsonb_array_elements(us.warps) w
    WHERE b.depth < 8
      AND NOT ((w->>'to')::int = ANY(b.path))
  )
  SELECT b.sector_id INTO v_close_non_fed
  FROM bfs b
  JOIN universe_structure u ON u.sector_id = b.sector_id
  WHERE u.region != 'Federation Space' AND b.depth >= 2
  ORDER BY b.depth, b.sector_id
  LIMIT 1;

  IF v_close_non_fed IS NULL THEN
    RAISE NOTICE 'omega_garrison: could not find non-Fed sector at depth >= 2; skipping garrison setup.';
    RETURN;
  END IF;

  -- Remote non-Fed sector: shallowest sector at depth >= 4 from the mega-port
  -- (distinct from the close one) so Eval3 can manage a "remote" garrison.
  WITH RECURSIVE bfs AS (
    SELECT v_mega_port AS sector_id, 0 AS depth, ARRAY[v_mega_port] AS path
    UNION ALL
    SELECT (w->>'to')::int, b.depth + 1, b.path || (w->>'to')::int
    FROM bfs b
    JOIN universe_structure us ON us.sector_id = b.sector_id
    CROSS JOIN jsonb_array_elements(us.warps) w
    WHERE b.depth < 10
      AND NOT ((w->>'to')::int = ANY(b.path))
  )
  SELECT b.sector_id INTO v_remote_non_fed
  FROM bfs b
  JOIN universe_structure u ON u.sector_id = b.sector_id
  WHERE u.region != 'Federation Space'
    AND b.depth >= 4
    AND b.sector_id != v_close_non_fed
  ORDER BY b.depth, b.sector_id
  LIMIT 1;

  -- Fall back to the close sector if the universe is too small to find a deep one.
  IF v_remote_non_fed IS NULL THEN
    RAISE NOTICE 'omega_garrison: no non-Fed sector at depth >= 4; reusing close sector for remote garrison.';
    v_remote_non_fed := v_close_non_fed;
  END IF;

  -- Move ships to their target sectors.
  UPDATE ship_instances SET current_sector = v_mega_port
    WHERE ship_id = '60000000-0000-4000-8000-f00000000001';
  UPDATE ship_instances SET current_sector = v_close_non_fed
    WHERE ship_id IN (
      '60000000-1000-4000-8000-f00000000001',
      '60000000-2000-4000-8000-f00000000001',
      '60000000-4000-4000-8000-f00000000001'
    );
  -- Eval3 stays at sector 0 — it operates on its remote garrison from Fed Space.

  -- Garrisons:
  --   Eval2 — defensive, 50 fighters at the close non-Fed sector
  --   Eval3 — toll, 50 fighters at the remote non-Fed sector (toll_amount 100)
  --   Eval4 — defensive, 50 fighters at the close non-Fed sector
  -- garrisons.PK is (sector_id, owner_id), so Eval2 and Eval4 in the same sector
  -- with different owners do not collide.
  INSERT INTO garrisons (sector_id, owner_id, fighters, mode, toll_amount, toll_balance) VALUES
    (v_close_non_fed,  '60000000-2000-4000-8000-000000000008', 50, 'defensive', 0,   0),
    (v_remote_non_fed, '60000000-3000-4000-8000-000000000008', 50, 'toll',      100, 0),
    (v_close_non_fed,  '60000000-4000-4000-8000-000000000008', 50, 'defensive', 0,   0);

  -- Pull adjacency + position metadata for each key sector to seed map_knowledge.
  SELECT
    COALESCE((SELECT jsonb_agg((w->>'to')::int) FROM jsonb_array_elements(warps) w), '[]'::jsonb),
    jsonb_build_array(position_x, position_y)
  INTO v_mp_adj, v_mp_pos
  FROM universe_structure WHERE sector_id = v_mega_port;

  SELECT
    COALESCE((SELECT jsonb_agg((w->>'to')::int) FROM jsonb_array_elements(warps) w), '[]'::jsonb),
    jsonb_build_array(position_x, position_y)
  INTO v_close_adj, v_close_pos
  FROM universe_structure WHERE sector_id = v_close_non_fed;

  SELECT
    COALESCE((SELECT jsonb_agg((w->>'to')::int) FROM jsonb_array_elements(warps) w), '[]'::jsonb),
    jsonb_build_array(position_x, position_y)
  INTO v_remote_adj, v_remote_pos
  FROM universe_structure WHERE sector_id = v_remote_non_fed;

  -- Every Omega character knows the mega-port + the two non-Fed sectors so
  -- list_known_ports, plot_course and path lookups all resolve without travel.
  UPDATE characters
  SET map_knowledge = jsonb_build_object(
    'sectors_visited', jsonb_build_object(
      v_mega_port::text, jsonb_build_object(
        'adjacent_sectors', v_mp_adj,
        'last_visited',     (NOW() - INTERVAL '2 days')::text,
        'position',         v_mp_pos
      ),
      v_close_non_fed::text, jsonb_build_object(
        'adjacent_sectors', v_close_adj,
        'last_visited',     (NOW() - INTERVAL '1 day')::text,
        'position',         v_close_pos
      ),
      v_remote_non_fed::text, jsonb_build_object(
        'adjacent_sectors', v_remote_adj,
        'last_visited',     (NOW() - INTERVAL '6 hours')::text,
        'position',         v_remote_pos
      )
    ),
    'total_sectors_visited',
      CASE WHEN v_remote_non_fed = v_close_non_fed THEN 2 ELSE 3 END
  )
  WHERE character_id = ANY(v_char_ids);
END $omega_garrison$;

COMMIT;
`;
