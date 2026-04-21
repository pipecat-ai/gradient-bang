-- Beta Kestrel Eval — kestrel_courier, 10k on ship, 5k in megabank
-- Seeds 11 variations (Eval0..Eval10) with slot-indexed character & ship UUIDs.
-- Slots 0..4 linked to the Beta base auth user. Slots 5..a each get their own
-- auth user (stays under 5-character-per-user trigger).
-- Usage: psql $LOCAL_API_POSTGRES_URL -f seeds/beta_kestrel.sql

BEGIN;

DELETE FROM events WHERE character_id IN (
  'b0000000-0000-4000-8000-000000000002',
  'b0000000-1000-4000-8000-000000000002',
  'b0000000-2000-4000-8000-000000000002',
  'b0000000-3000-4000-8000-000000000002',
  'b0000000-4000-4000-8000-000000000002',
  'b0000000-5000-4000-8000-000000000002',
  'b0000000-6000-4000-8000-000000000002',
  'b0000000-7000-4000-8000-000000000002',
  'b0000000-8000-4000-8000-000000000002',
  'b0000000-9000-4000-8000-000000000002',
  'b0000000-a000-4000-8000-000000000002'
);
DELETE FROM events WHERE sender_id IN (
  'b0000000-0000-4000-8000-000000000002',
  'b0000000-1000-4000-8000-000000000002',
  'b0000000-2000-4000-8000-000000000002',
  'b0000000-3000-4000-8000-000000000002',
  'b0000000-4000-4000-8000-000000000002',
  'b0000000-5000-4000-8000-000000000002',
  'b0000000-6000-4000-8000-000000000002',
  'b0000000-7000-4000-8000-000000000002',
  'b0000000-8000-4000-8000-000000000002',
  'b0000000-9000-4000-8000-000000000002',
  'b0000000-a000-4000-8000-000000000002'
);
DELETE FROM events WHERE ship_id IN (
  SELECT ship_id FROM ship_instances WHERE owner_character_id IN (
    'b0000000-0000-4000-8000-000000000002',
    'b0000000-1000-4000-8000-000000000002',
    'b0000000-2000-4000-8000-000000000002',
    'b0000000-3000-4000-8000-000000000002',
    'b0000000-4000-4000-8000-000000000002',
    'b0000000-5000-4000-8000-000000000002',
    'b0000000-6000-4000-8000-000000000002',
    'b0000000-7000-4000-8000-000000000002',
    'b0000000-8000-4000-8000-000000000002',
    'b0000000-9000-4000-8000-000000000002',
    'b0000000-a000-4000-8000-000000000002'
  )
);
DELETE FROM user_characters WHERE character_id IN (
  'b0000000-0000-4000-8000-000000000002',
  'b0000000-1000-4000-8000-000000000002',
  'b0000000-2000-4000-8000-000000000002',
  'b0000000-3000-4000-8000-000000000002',
  'b0000000-4000-4000-8000-000000000002',
  'b0000000-5000-4000-8000-000000000002',
  'b0000000-6000-4000-8000-000000000002',
  'b0000000-7000-4000-8000-000000000002',
  'b0000000-8000-4000-8000-000000000002',
  'b0000000-9000-4000-8000-000000000002',
  'b0000000-a000-4000-8000-000000000002'
);
UPDATE characters SET current_ship_id = NULL WHERE character_id IN (
  'b0000000-0000-4000-8000-000000000002',
  'b0000000-1000-4000-8000-000000000002',
  'b0000000-2000-4000-8000-000000000002',
  'b0000000-3000-4000-8000-000000000002',
  'b0000000-4000-4000-8000-000000000002',
  'b0000000-5000-4000-8000-000000000002',
  'b0000000-6000-4000-8000-000000000002',
  'b0000000-7000-4000-8000-000000000002',
  'b0000000-8000-4000-8000-000000000002',
  'b0000000-9000-4000-8000-000000000002',
  'b0000000-a000-4000-8000-000000000002'
);
DELETE FROM ship_instances WHERE owner_character_id IN (
  'b0000000-0000-4000-8000-000000000002',
  'b0000000-1000-4000-8000-000000000002',
  'b0000000-2000-4000-8000-000000000002',
  'b0000000-3000-4000-8000-000000000002',
  'b0000000-4000-4000-8000-000000000002',
  'b0000000-5000-4000-8000-000000000002',
  'b0000000-6000-4000-8000-000000000002',
  'b0000000-7000-4000-8000-000000000002',
  'b0000000-8000-4000-8000-000000000002',
  'b0000000-9000-4000-8000-000000000002',
  'b0000000-a000-4000-8000-000000000002'
);
DELETE FROM characters WHERE character_id IN (
  'b0000000-0000-4000-8000-000000000002',
  'b0000000-1000-4000-8000-000000000002',
  'b0000000-2000-4000-8000-000000000002',
  'b0000000-3000-4000-8000-000000000002',
  'b0000000-4000-4000-8000-000000000002',
  'b0000000-5000-4000-8000-000000000002',
  'b0000000-6000-4000-8000-000000000002',
  'b0000000-7000-4000-8000-000000000002',
  'b0000000-8000-4000-8000-000000000002',
  'b0000000-9000-4000-8000-000000000002',
  'b0000000-a000-4000-8000-000000000002'
);

-- Overflow auth users for slots 5..a
INSERT INTO auth.users (id, email, aud, role, is_sso_user, is_anonymous) VALUES
  ('b0000000-5000-4aaa-8000-000000000002', 'beta-eval-5@gradientbang.com',  'authenticated', 'authenticated', false, false),
  ('b0000000-6000-4aaa-8000-000000000002', 'beta-eval-6@gradientbang.com',  'authenticated', 'authenticated', false, false),
  ('b0000000-7000-4aaa-8000-000000000002', 'beta-eval-7@gradientbang.com',  'authenticated', 'authenticated', false, false),
  ('b0000000-8000-4aaa-8000-000000000002', 'beta-eval-8@gradientbang.com',  'authenticated', 'authenticated', false, false),
  ('b0000000-9000-4aaa-8000-000000000002', 'beta-eval-9@gradientbang.com',  'authenticated', 'authenticated', false, false),
  ('b0000000-a000-4aaa-8000-000000000002', 'beta-eval-10@gradientbang.com', 'authenticated', 'authenticated', false, false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO characters (character_id, name, credits_in_megabank, map_knowledge) VALUES
  ('b0000000-0000-4000-8000-000000000002', 'Beta Kestrel Eval0',  5000, '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('b0000000-1000-4000-8000-000000000002', 'Beta Kestrel Eval1',  5000, '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('b0000000-2000-4000-8000-000000000002', 'Beta Kestrel Eval2',  5000, '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('b0000000-3000-4000-8000-000000000002', 'Beta Kestrel Eval3',  5000, '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('b0000000-4000-4000-8000-000000000002', 'Beta Kestrel Eval4',  5000, '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('b0000000-5000-4000-8000-000000000002', 'Beta Kestrel Eval5',  5000, '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('b0000000-6000-4000-8000-000000000002', 'Beta Kestrel Eval6',  5000, '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('b0000000-7000-4000-8000-000000000002', 'Beta Kestrel Eval7',  5000, '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('b0000000-8000-4000-8000-000000000002', 'Beta Kestrel Eval8',  5000, '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('b0000000-9000-4000-8000-000000000002', 'Beta Kestrel Eval9',  5000, '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('b0000000-a000-4000-8000-000000000002', 'Beta Kestrel Eval10', 5000, '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}');

INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES
  ('b0000000-0000-4000-8000-b00000000002', 'b0000000-0000-4000-8000-000000000002', 'character', 'b0000000-0000-4000-8000-000000000002', 'kestrel_courier', 0, 10000, 500, 150, 300),
  ('b0000000-1000-4000-8000-b00000000002', 'b0000000-1000-4000-8000-000000000002', 'character', 'b0000000-1000-4000-8000-000000000002', 'kestrel_courier', 0, 10000, 500, 150, 300),
  ('b0000000-2000-4000-8000-b00000000002', 'b0000000-2000-4000-8000-000000000002', 'character', 'b0000000-2000-4000-8000-000000000002', 'kestrel_courier', 0, 10000, 500, 150, 300),
  ('b0000000-3000-4000-8000-b00000000002', 'b0000000-3000-4000-8000-000000000002', 'character', 'b0000000-3000-4000-8000-000000000002', 'kestrel_courier', 0, 10000, 500, 150, 300),
  ('b0000000-4000-4000-8000-b00000000002', 'b0000000-4000-4000-8000-000000000002', 'character', 'b0000000-4000-4000-8000-000000000002', 'kestrel_courier', 0, 10000, 500, 150, 300),
  ('b0000000-5000-4000-8000-b00000000002', 'b0000000-5000-4000-8000-000000000002', 'character', 'b0000000-5000-4000-8000-000000000002', 'kestrel_courier', 0, 10000, 500, 150, 300),
  ('b0000000-6000-4000-8000-b00000000002', 'b0000000-6000-4000-8000-000000000002', 'character', 'b0000000-6000-4000-8000-000000000002', 'kestrel_courier', 0, 10000, 500, 150, 300),
  ('b0000000-7000-4000-8000-b00000000002', 'b0000000-7000-4000-8000-000000000002', 'character', 'b0000000-7000-4000-8000-000000000002', 'kestrel_courier', 0, 10000, 500, 150, 300),
  ('b0000000-8000-4000-8000-b00000000002', 'b0000000-8000-4000-8000-000000000002', 'character', 'b0000000-8000-4000-8000-000000000002', 'kestrel_courier', 0, 10000, 500, 150, 300),
  ('b0000000-9000-4000-8000-b00000000002', 'b0000000-9000-4000-8000-000000000002', 'character', 'b0000000-9000-4000-8000-000000000002', 'kestrel_courier', 0, 10000, 500, 150, 300),
  ('b0000000-a000-4000-8000-b00000000002', 'b0000000-a000-4000-8000-000000000002', 'character', 'b0000000-a000-4000-8000-000000000002', 'kestrel_courier', 0, 10000, 500, 150, 300);

UPDATE characters SET current_ship_id = 'b0000000-0000-4000-8000-b00000000002' WHERE character_id = 'b0000000-0000-4000-8000-000000000002';
UPDATE characters SET current_ship_id = 'b0000000-1000-4000-8000-b00000000002' WHERE character_id = 'b0000000-1000-4000-8000-000000000002';
UPDATE characters SET current_ship_id = 'b0000000-2000-4000-8000-b00000000002' WHERE character_id = 'b0000000-2000-4000-8000-000000000002';
UPDATE characters SET current_ship_id = 'b0000000-3000-4000-8000-b00000000002' WHERE character_id = 'b0000000-3000-4000-8000-000000000002';
UPDATE characters SET current_ship_id = 'b0000000-4000-4000-8000-b00000000002' WHERE character_id = 'b0000000-4000-4000-8000-000000000002';
UPDATE characters SET current_ship_id = 'b0000000-5000-4000-8000-b00000000002' WHERE character_id = 'b0000000-5000-4000-8000-000000000002';
UPDATE characters SET current_ship_id = 'b0000000-6000-4000-8000-b00000000002' WHERE character_id = 'b0000000-6000-4000-8000-000000000002';
UPDATE characters SET current_ship_id = 'b0000000-7000-4000-8000-b00000000002' WHERE character_id = 'b0000000-7000-4000-8000-000000000002';
UPDATE characters SET current_ship_id = 'b0000000-8000-4000-8000-b00000000002' WHERE character_id = 'b0000000-8000-4000-8000-000000000002';
UPDATE characters SET current_ship_id = 'b0000000-9000-4000-8000-b00000000002' WHERE character_id = 'b0000000-9000-4000-8000-000000000002';
UPDATE characters SET current_ship_id = 'b0000000-a000-4000-8000-b00000000002' WHERE character_id = 'b0000000-a000-4000-8000-000000000002';

INSERT INTO user_characters (user_id, character_id) VALUES
  ('b0000000-0000-4aaa-8000-000000000002',   'b0000000-0000-4000-8000-000000000002'),
  ('b0000000-0000-4aaa-8000-000000000002',   'b0000000-1000-4000-8000-000000000002'),
  ('b0000000-0000-4aaa-8000-000000000002',   'b0000000-2000-4000-8000-000000000002'),
  ('b0000000-0000-4aaa-8000-000000000002',   'b0000000-3000-4000-8000-000000000002'),
  ('b0000000-0000-4aaa-8000-000000000002',   'b0000000-4000-4000-8000-000000000002'),
  ('b0000000-5000-4aaa-8000-000000000002',   'b0000000-5000-4000-8000-000000000002'),
  ('b0000000-6000-4aaa-8000-000000000002',   'b0000000-6000-4000-8000-000000000002'),
  ('b0000000-7000-4aaa-8000-000000000002',   'b0000000-7000-4000-8000-000000000002'),
  ('b0000000-8000-4aaa-8000-000000000002',   'b0000000-8000-4000-8000-000000000002'),
  ('b0000000-9000-4aaa-8000-000000000002',   'b0000000-9000-4000-8000-000000000002'),
  ('b0000000-a000-4aaa-8000-000000000002',   'b0000000-a000-4000-8000-000000000002');

-- Seed a prior-session history so "what did I do last session?" event_log queries
-- have content. One session.started + one task.finish per character, timestamped
-- ~2 days ago. Teardown at the top of this script already wiped these on re-run.
INSERT INTO events (timestamp, direction, event_type, character_id, sender_id, sector_id, ship_id, payload, meta)
SELECT
  NOW() - INTERVAL '2 days' + e.offset_interval,
  'event_out',
  e.event_type,
  v.character_id,
  v.character_id,
  v.sector_id,
  v.ship_id,
  e.payload::jsonb,
  '{"source": "beta-kestrel-eval-seed"}'::jsonb
FROM (VALUES
  ('b0000000-0000-4000-8000-000000000002'::uuid, 0, 'b0000000-0000-4000-8000-b00000000002'::uuid),
  ('b0000000-1000-4000-8000-000000000002'::uuid, 0, 'b0000000-1000-4000-8000-b00000000002'::uuid),
  ('b0000000-2000-4000-8000-000000000002'::uuid, 0, 'b0000000-2000-4000-8000-b00000000002'::uuid),
  ('b0000000-3000-4000-8000-000000000002'::uuid, 0, 'b0000000-3000-4000-8000-b00000000002'::uuid),
  ('b0000000-4000-4000-8000-000000000002'::uuid, 0, 'b0000000-4000-4000-8000-b00000000002'::uuid),
  ('b0000000-5000-4000-8000-000000000002'::uuid, 0, 'b0000000-5000-4000-8000-b00000000002'::uuid),
  ('b0000000-6000-4000-8000-000000000002'::uuid, 0, 'b0000000-6000-4000-8000-b00000000002'::uuid),
  ('b0000000-7000-4000-8000-000000000002'::uuid, 0, 'b0000000-7000-4000-8000-b00000000002'::uuid),
  ('b0000000-8000-4000-8000-000000000002'::uuid, 0, 'b0000000-8000-4000-8000-b00000000002'::uuid),
  ('b0000000-9000-4000-8000-000000000002'::uuid, 0, 'b0000000-9000-4000-8000-b00000000002'::uuid),
  ('b0000000-a000-4000-8000-000000000002'::uuid, 0, 'b0000000-a000-4000-8000-b00000000002'::uuid)
) AS v(character_id, sector_id, ship_id)
CROSS JOIN (VALUES
  ('session.started', INTERVAL '0 minutes', '{"source": "seed", "sector": 0, "ship_name": "Kestrel Courier", "ship_type": "kestrel_courier"}'),
  ('task.finish',     INTERVAL '10 minutes', '{"task_summary": "Sold 10 units of Quantum Foam at the local port for a 330 credit profit.", "task_status": "completed"}')
) AS e(event_type, offset_interval, payload);

-- Give every character knowledge of one mega-port so "find the nearest mega-port"
-- and list_known_ports(mega=true) calls resolve without exploration. Picks the
-- first configured mega-port from universe_config at seed time.
DO $beta_mega_port$
DECLARE
  v_mega_port INT;
  v_adj JSONB;
  v_pos JSONB;
  v_sector_entry JSONB;
  v_char_ids UUID[] := ARRAY[
    'b0000000-0000-4000-8000-000000000002'::uuid,
    'b0000000-1000-4000-8000-000000000002'::uuid,
    'b0000000-2000-4000-8000-000000000002'::uuid,
    'b0000000-3000-4000-8000-000000000002'::uuid,
    'b0000000-4000-4000-8000-000000000002'::uuid,
    'b0000000-5000-4000-8000-000000000002'::uuid,
    'b0000000-6000-4000-8000-000000000002'::uuid,
    'b0000000-7000-4000-8000-000000000002'::uuid,
    'b0000000-8000-4000-8000-000000000002'::uuid,
    'b0000000-9000-4000-8000-000000000002'::uuid,
    'b0000000-a000-4000-8000-000000000002'::uuid
  ];
BEGIN
  SELECT (meta->'mega_port_sectors'->>0)::int INTO v_mega_port
    FROM universe_config WHERE id = 1;
  IF v_mega_port IS NULL THEN
    RAISE NOTICE 'No mega-port configured in universe_config; skipping mega-port knowledge seed.';
    RETURN;
  END IF;
  SELECT
    COALESCE((SELECT jsonb_agg((w->>'to')::int) FROM jsonb_array_elements(warps) w), '[]'::jsonb),
    jsonb_build_array(position_x, position_y)
  INTO v_adj, v_pos
  FROM universe_structure WHERE sector_id = v_mega_port;
  v_sector_entry := jsonb_build_object(
    'adjacent_sectors', v_adj,
    'last_visited', (NOW() - INTERVAL '2 days')::text,
    'position', v_pos
  );
  UPDATE characters
  SET map_knowledge = jsonb_set(
    COALESCE(map_knowledge, '{"sectors_visited": {}, "total_sectors_visited": 0}'::jsonb),
    ARRAY['sectors_visited', v_mega_port::text],
    v_sector_entry
  )
  WHERE character_id = ANY(v_char_ids);
  UPDATE characters
  SET map_knowledge = jsonb_set(
    map_knowledge,
    '{total_sectors_visited}',
    to_jsonb((SELECT count(*) FROM jsonb_object_keys(map_knowledge->'sectors_visited')))
  )
  WHERE character_id = ANY(v_char_ids);
END $beta_mega_port$;

-- Add scenario-target sector 5 for "route from current sector to sector 5" (246179).
DO $beta_target_sectors$
DECLARE
  v_char_ids UUID[] := ARRAY[
    'b0000000-0000-4000-8000-000000000002'::uuid, 'b0000000-1000-4000-8000-000000000002'::uuid,
    'b0000000-2000-4000-8000-000000000002'::uuid, 'b0000000-3000-4000-8000-000000000002'::uuid,
    'b0000000-4000-4000-8000-000000000002'::uuid, 'b0000000-5000-4000-8000-000000000002'::uuid,
    'b0000000-6000-4000-8000-000000000002'::uuid, 'b0000000-7000-4000-8000-000000000002'::uuid,
    'b0000000-8000-4000-8000-000000000002'::uuid, 'b0000000-9000-4000-8000-000000000002'::uuid,
    'b0000000-a000-4000-8000-000000000002'::uuid
  ];
  v_addition JSONB;
BEGIN
  SELECT COALESCE(jsonb_object_agg(
    us.sector_id::text,
    jsonb_build_object(
      'adjacent_sectors',
      COALESCE((SELECT jsonb_agg((w->>'to')::int) FROM jsonb_array_elements(us.warps) w), '[]'::jsonb),
      'last_visited', (NOW() - INTERVAL '1 day')::text,
      'position', jsonb_build_array(us.position_x, us.position_y)
    )
  ), '{}'::jsonb)
  INTO v_addition
  FROM (VALUES (5)) AS s(sector_id)
  JOIN universe_structure us ON us.sector_id = s.sector_id;
  IF v_addition = '{}'::jsonb THEN RETURN; END IF;
  UPDATE characters
  SET map_knowledge = jsonb_set(
    COALESCE(map_knowledge, '{"sectors_visited": {}, "total_sectors_visited": 0}'::jsonb),
    '{sectors_visited}',
    COALESCE(map_knowledge->'sectors_visited', '{}'::jsonb) || v_addition
  )
  WHERE character_id = ANY(v_char_ids);
  UPDATE characters
  SET map_knowledge = jsonb_set(
    map_knowledge, '{total_sectors_visited}',
    to_jsonb((SELECT count(*) FROM jsonb_object_keys(map_knowledge->'sectors_visited')))
  )
  WHERE character_id = ANY(v_char_ids);
END $beta_target_sectors$;

-- Backdate first_visit and created_at so the join is_first_visit heuristic returns false.
UPDATE characters SET first_visit = NOW() - INTERVAL '1 day', created_at = NOW() - INTERVAL '1 day' WHERE character_id IN (
  'b0000000-0000-4000-8000-000000000002',
  'b0000000-1000-4000-8000-000000000002',
  'b0000000-2000-4000-8000-000000000002',
  'b0000000-3000-4000-8000-000000000002',
  'b0000000-4000-4000-8000-000000000002',
  'b0000000-5000-4000-8000-000000000002',
  'b0000000-6000-4000-8000-000000000002',
  'b0000000-7000-4000-8000-000000000002',
  'b0000000-8000-4000-8000-000000000002',
  'b0000000-9000-4000-8000-000000000002',
  'b0000000-a000-4000-8000-000000000002'
);

COMMIT;
