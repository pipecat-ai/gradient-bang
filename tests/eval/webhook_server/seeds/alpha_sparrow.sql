-- Alpha Sparrow Eval — fresh character with sparrow_scout
-- Seeds 10 variations (Eval0..Eval9) with slot-indexed character & ship UUIDs.
-- Slots 0..4 are linked to the Alpha base auth user. Slots 5..9 each get their
-- own auth user (to stay under the 5-character-per-user trigger).
-- Usage: psql $LOCAL_API_POSTGRES_URL -f seeds/alpha_sparrow.sql

BEGIN;

-- Defensive: pre-option-c epsilon_corp.sql seeded "Eval Corp" with an Alpha
-- slot as its founder. If that corp still exists, tear it down before
-- deleting Alpha characters, so the corporations_founder_id_fkey doesn't block.
WITH alpha_corps AS (
  SELECT corp_id FROM corporations WHERE founder_id IN (
    'a0000000-0000-4000-8000-000000000001',
    'a0000000-1000-4000-8000-000000000001',
    'a0000000-2000-4000-8000-000000000001',
    'a0000000-3000-4000-8000-000000000001',
    'a0000000-4000-4000-8000-000000000001',
    'a0000000-5000-4000-8000-000000000001',
    'a0000000-6000-4000-8000-000000000001',
    'a0000000-7000-4000-8000-000000000001',
    'a0000000-8000-4000-8000-000000000001',
    'a0000000-9000-4000-8000-000000000001'
  )
)
DELETE FROM events WHERE ship_id IN (
  SELECT ship_id FROM ship_instances WHERE owner_corporation_id IN (SELECT corp_id FROM alpha_corps)
);
DELETE FROM corporation_ships WHERE corp_id IN (
  SELECT corp_id FROM corporations WHERE founder_id IN (
    'a0000000-0000-4000-8000-000000000001', 'a0000000-1000-4000-8000-000000000001',
    'a0000000-2000-4000-8000-000000000001', 'a0000000-3000-4000-8000-000000000001',
    'a0000000-4000-4000-8000-000000000001', 'a0000000-5000-4000-8000-000000000001',
    'a0000000-6000-4000-8000-000000000001', 'a0000000-7000-4000-8000-000000000001',
    'a0000000-8000-4000-8000-000000000001', 'a0000000-9000-4000-8000-000000000001'
  )
);
DELETE FROM corporation_members WHERE corp_id IN (
  SELECT corp_id FROM corporations WHERE founder_id IN (
    'a0000000-0000-4000-8000-000000000001', 'a0000000-1000-4000-8000-000000000001',
    'a0000000-2000-4000-8000-000000000001', 'a0000000-3000-4000-8000-000000000001',
    'a0000000-4000-4000-8000-000000000001', 'a0000000-5000-4000-8000-000000000001',
    'a0000000-6000-4000-8000-000000000001', 'a0000000-7000-4000-8000-000000000001',
    'a0000000-8000-4000-8000-000000000001', 'a0000000-9000-4000-8000-000000000001'
  )
);
DELETE FROM ship_instances WHERE owner_corporation_id IN (
  SELECT corp_id FROM corporations WHERE founder_id IN (
    'a0000000-0000-4000-8000-000000000001', 'a0000000-1000-4000-8000-000000000001',
    'a0000000-2000-4000-8000-000000000001', 'a0000000-3000-4000-8000-000000000001',
    'a0000000-4000-4000-8000-000000000001', 'a0000000-5000-4000-8000-000000000001',
    'a0000000-6000-4000-8000-000000000001', 'a0000000-7000-4000-8000-000000000001',
    'a0000000-8000-4000-8000-000000000001', 'a0000000-9000-4000-8000-000000000001'
  )
);
UPDATE characters SET corporation_id = NULL WHERE corporation_id IN (
  SELECT corp_id FROM corporations WHERE founder_id IN (
    'a0000000-0000-4000-8000-000000000001', 'a0000000-1000-4000-8000-000000000001',
    'a0000000-2000-4000-8000-000000000001', 'a0000000-3000-4000-8000-000000000001',
    'a0000000-4000-4000-8000-000000000001', 'a0000000-5000-4000-8000-000000000001',
    'a0000000-6000-4000-8000-000000000001', 'a0000000-7000-4000-8000-000000000001',
    'a0000000-8000-4000-8000-000000000001', 'a0000000-9000-4000-8000-000000000001'
  )
);
DELETE FROM corporations WHERE founder_id IN (
  'a0000000-0000-4000-8000-000000000001', 'a0000000-1000-4000-8000-000000000001',
  'a0000000-2000-4000-8000-000000000001', 'a0000000-3000-4000-8000-000000000001',
  'a0000000-4000-4000-8000-000000000001', 'a0000000-5000-4000-8000-000000000001',
  'a0000000-6000-4000-8000-000000000001', 'a0000000-7000-4000-8000-000000000001',
  'a0000000-8000-4000-8000-000000000001', 'a0000000-9000-4000-8000-000000000001'
);

-- Teardown all variations
DELETE FROM events WHERE character_id IN (
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-1000-4000-8000-000000000001',
  'a0000000-2000-4000-8000-000000000001',
  'a0000000-3000-4000-8000-000000000001',
  'a0000000-4000-4000-8000-000000000001',
  'a0000000-5000-4000-8000-000000000001',
  'a0000000-6000-4000-8000-000000000001',
  'a0000000-7000-4000-8000-000000000001',
  'a0000000-8000-4000-8000-000000000001',
  'a0000000-9000-4000-8000-000000000001'
);
DELETE FROM events WHERE sender_id IN (
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-1000-4000-8000-000000000001',
  'a0000000-2000-4000-8000-000000000001',
  'a0000000-3000-4000-8000-000000000001',
  'a0000000-4000-4000-8000-000000000001',
  'a0000000-5000-4000-8000-000000000001',
  'a0000000-6000-4000-8000-000000000001',
  'a0000000-7000-4000-8000-000000000001',
  'a0000000-8000-4000-8000-000000000001',
  'a0000000-9000-4000-8000-000000000001'
);
DELETE FROM events WHERE ship_id IN (
  SELECT ship_id FROM ship_instances WHERE owner_character_id IN (
    'a0000000-0000-4000-8000-000000000001',
    'a0000000-1000-4000-8000-000000000001',
    'a0000000-2000-4000-8000-000000000001',
    'a0000000-3000-4000-8000-000000000001',
    'a0000000-4000-4000-8000-000000000001',
    'a0000000-5000-4000-8000-000000000001',
    'a0000000-6000-4000-8000-000000000001',
    'a0000000-7000-4000-8000-000000000001',
    'a0000000-8000-4000-8000-000000000001',
    'a0000000-9000-4000-8000-000000000001'
  )
);
DELETE FROM user_characters WHERE character_id IN (
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-1000-4000-8000-000000000001',
  'a0000000-2000-4000-8000-000000000001',
  'a0000000-3000-4000-8000-000000000001',
  'a0000000-4000-4000-8000-000000000001',
  'a0000000-5000-4000-8000-000000000001',
  'a0000000-6000-4000-8000-000000000001',
  'a0000000-7000-4000-8000-000000000001',
  'a0000000-8000-4000-8000-000000000001',
  'a0000000-9000-4000-8000-000000000001'
);
UPDATE characters SET current_ship_id = NULL WHERE character_id IN (
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-1000-4000-8000-000000000001',
  'a0000000-2000-4000-8000-000000000001',
  'a0000000-3000-4000-8000-000000000001',
  'a0000000-4000-4000-8000-000000000001',
  'a0000000-5000-4000-8000-000000000001',
  'a0000000-6000-4000-8000-000000000001',
  'a0000000-7000-4000-8000-000000000001',
  'a0000000-8000-4000-8000-000000000001',
  'a0000000-9000-4000-8000-000000000001'
);
DELETE FROM ship_instances WHERE owner_character_id IN (
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-1000-4000-8000-000000000001',
  'a0000000-2000-4000-8000-000000000001',
  'a0000000-3000-4000-8000-000000000001',
  'a0000000-4000-4000-8000-000000000001',
  'a0000000-5000-4000-8000-000000000001',
  'a0000000-6000-4000-8000-000000000001',
  'a0000000-7000-4000-8000-000000000001',
  'a0000000-8000-4000-8000-000000000001',
  'a0000000-9000-4000-8000-000000000001'
);
DELETE FROM characters WHERE character_id IN (
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-1000-4000-8000-000000000001',
  'a0000000-2000-4000-8000-000000000001',
  'a0000000-3000-4000-8000-000000000001',
  'a0000000-4000-4000-8000-000000000001',
  'a0000000-5000-4000-8000-000000000001',
  'a0000000-6000-4000-8000-000000000001',
  'a0000000-7000-4000-8000-000000000001',
  'a0000000-8000-4000-8000-000000000001',
  'a0000000-9000-4000-8000-000000000001'
);

-- Overflow auth users for slots 5..9 (stays under 5-char cap on the base eval user)
INSERT INTO auth.users (id, email, aud, role, is_sso_user, is_anonymous) VALUES
  ('a0000000-5000-4aaa-8000-000000000001', 'alpha-eval-5@gradientbang.com', 'authenticated', 'authenticated', false, false),
  ('a0000000-6000-4aaa-8000-000000000001', 'alpha-eval-6@gradientbang.com', 'authenticated', 'authenticated', false, false),
  ('a0000000-7000-4aaa-8000-000000000001', 'alpha-eval-7@gradientbang.com', 'authenticated', 'authenticated', false, false),
  ('a0000000-8000-4aaa-8000-000000000001', 'alpha-eval-8@gradientbang.com', 'authenticated', 'authenticated', false, false),
  ('a0000000-9000-4aaa-8000-000000000001', 'alpha-eval-9@gradientbang.com', 'authenticated', 'authenticated', false, false)
ON CONFLICT (id) DO NOTHING;

-- Seed 10 variations
INSERT INTO characters (character_id, name, map_knowledge) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'Alpha Sparrow Eval0', '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('a0000000-1000-4000-8000-000000000001', 'Alpha Sparrow Eval1', '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('a0000000-2000-4000-8000-000000000001', 'Alpha Sparrow Eval2', '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('a0000000-3000-4000-8000-000000000001', 'Alpha Sparrow Eval3', '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('a0000000-4000-4000-8000-000000000001', 'Alpha Sparrow Eval4', '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('a0000000-5000-4000-8000-000000000001', 'Alpha Sparrow Eval5', '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('a0000000-6000-4000-8000-000000000001', 'Alpha Sparrow Eval6', '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('a0000000-7000-4000-8000-000000000001', 'Alpha Sparrow Eval7', '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('a0000000-8000-4000-8000-000000000001', 'Alpha Sparrow Eval8', '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('a0000000-9000-4000-8000-000000000001', 'Alpha Sparrow Eval9', '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}');

INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES
  ('a0000000-0000-4000-8000-a00000000001', 'a0000000-0000-4000-8000-000000000001', 'character', 'a0000000-0000-4000-8000-000000000001', 'sparrow_scout', 0, 5000, 450, 120, 200),
  ('a0000000-1000-4000-8000-a00000000001', 'a0000000-1000-4000-8000-000000000001', 'character', 'a0000000-1000-4000-8000-000000000001', 'sparrow_scout', 0, 5000, 450, 120, 200),
  ('a0000000-2000-4000-8000-a00000000001', 'a0000000-2000-4000-8000-000000000001', 'character', 'a0000000-2000-4000-8000-000000000001', 'sparrow_scout', 0, 5000, 450, 120, 200),
  ('a0000000-3000-4000-8000-a00000000001', 'a0000000-3000-4000-8000-000000000001', 'character', 'a0000000-3000-4000-8000-000000000001', 'sparrow_scout', 0, 5000, 450, 120, 200),
  ('a0000000-4000-4000-8000-a00000000001', 'a0000000-4000-4000-8000-000000000001', 'character', 'a0000000-4000-4000-8000-000000000001', 'sparrow_scout', 0, 5000, 450, 120, 200),
  ('a0000000-5000-4000-8000-a00000000001', 'a0000000-5000-4000-8000-000000000001', 'character', 'a0000000-5000-4000-8000-000000000001', 'sparrow_scout', 0, 5000, 450, 120, 200),
  ('a0000000-6000-4000-8000-a00000000001', 'a0000000-6000-4000-8000-000000000001', 'character', 'a0000000-6000-4000-8000-000000000001', 'sparrow_scout', 0, 5000, 450, 120, 200),
  ('a0000000-7000-4000-8000-a00000000001', 'a0000000-7000-4000-8000-000000000001', 'character', 'a0000000-7000-4000-8000-000000000001', 'sparrow_scout', 0, 5000, 450, 120, 200),
  ('a0000000-8000-4000-8000-a00000000001', 'a0000000-8000-4000-8000-000000000001', 'character', 'a0000000-8000-4000-8000-000000000001', 'sparrow_scout', 0, 5000, 450, 120, 200),
  ('a0000000-9000-4000-8000-a00000000001', 'a0000000-9000-4000-8000-000000000001', 'character', 'a0000000-9000-4000-8000-000000000001', 'sparrow_scout', 0, 5000, 450, 120, 200);

UPDATE characters SET current_ship_id = 'a0000000-0000-4000-8000-a00000000001' WHERE character_id = 'a0000000-0000-4000-8000-000000000001';
UPDATE characters SET current_ship_id = 'a0000000-1000-4000-8000-a00000000001' WHERE character_id = 'a0000000-1000-4000-8000-000000000001';
UPDATE characters SET current_ship_id = 'a0000000-2000-4000-8000-a00000000001' WHERE character_id = 'a0000000-2000-4000-8000-000000000001';
UPDATE characters SET current_ship_id = 'a0000000-3000-4000-8000-a00000000001' WHERE character_id = 'a0000000-3000-4000-8000-000000000001';
UPDATE characters SET current_ship_id = 'a0000000-4000-4000-8000-a00000000001' WHERE character_id = 'a0000000-4000-4000-8000-000000000001';
UPDATE characters SET current_ship_id = 'a0000000-5000-4000-8000-a00000000001' WHERE character_id = 'a0000000-5000-4000-8000-000000000001';
UPDATE characters SET current_ship_id = 'a0000000-6000-4000-8000-a00000000001' WHERE character_id = 'a0000000-6000-4000-8000-000000000001';
UPDATE characters SET current_ship_id = 'a0000000-7000-4000-8000-a00000000001' WHERE character_id = 'a0000000-7000-4000-8000-000000000001';
UPDATE characters SET current_ship_id = 'a0000000-8000-4000-8000-a00000000001' WHERE character_id = 'a0000000-8000-4000-8000-000000000001';
UPDATE characters SET current_ship_id = 'a0000000-9000-4000-8000-a00000000001' WHERE character_id = 'a0000000-9000-4000-8000-000000000001';

INSERT INTO user_characters (user_id, character_id) VALUES
  ('a0000000-0000-4aaa-8000-000000000001', 'a0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4aaa-8000-000000000001', 'a0000000-1000-4000-8000-000000000001'),
  ('a0000000-0000-4aaa-8000-000000000001', 'a0000000-2000-4000-8000-000000000001'),
  ('a0000000-0000-4aaa-8000-000000000001', 'a0000000-3000-4000-8000-000000000001'),
  ('a0000000-0000-4aaa-8000-000000000001', 'a0000000-4000-4000-8000-000000000001'),
  ('a0000000-5000-4aaa-8000-000000000001', 'a0000000-5000-4000-8000-000000000001'),
  ('a0000000-6000-4aaa-8000-000000000001', 'a0000000-6000-4000-8000-000000000001'),
  ('a0000000-7000-4aaa-8000-000000000001', 'a0000000-7000-4000-8000-000000000001'),
  ('a0000000-8000-4aaa-8000-000000000001', 'a0000000-8000-4000-8000-000000000001'),
  ('a0000000-9000-4aaa-8000-000000000001', 'a0000000-9000-4000-8000-000000000001');

-- Add scenario-target sectors (500, 600) to each variation's map_knowledge so
-- "Move my ship to sector 500 / 600" scenarios can resolve paths. Only adds
-- sectors that exist in universe_structure (silent no-op otherwise).
DO $alpha_target_sectors$
DECLARE
  v_char_ids UUID[] := ARRAY[
    'a0000000-0000-4000-8000-000000000001'::uuid,
    'a0000000-1000-4000-8000-000000000001'::uuid,
    'a0000000-2000-4000-8000-000000000001'::uuid,
    'a0000000-3000-4000-8000-000000000001'::uuid,
    'a0000000-4000-4000-8000-000000000001'::uuid,
    'a0000000-5000-4000-8000-000000000001'::uuid,
    'a0000000-6000-4000-8000-000000000001'::uuid,
    'a0000000-7000-4000-8000-000000000001'::uuid,
    'a0000000-8000-4000-8000-000000000001'::uuid,
    'a0000000-9000-4000-8000-000000000001'::uuid
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
  FROM (VALUES (500), (600)) AS s(sector_id)
  JOIN universe_structure us ON us.sector_id = s.sector_id;

  IF v_addition = '{}'::jsonb THEN
    RAISE NOTICE 'alpha_sparrow: neither sector 500 nor 600 exists in universe_structure; skipping target-sector knowledge seed.';
    RETURN;
  END IF;

  UPDATE characters
  SET map_knowledge = jsonb_set(
    COALESCE(map_knowledge, '{"sectors_visited": {}, "total_sectors_visited": 0}'::jsonb),
    '{sectors_visited}',
    COALESCE(map_knowledge->'sectors_visited', '{}'::jsonb) || v_addition
  )
  WHERE character_id = ANY(v_char_ids);
  UPDATE characters
  SET map_knowledge = jsonb_set(
    map_knowledge,
    '{total_sectors_visited}',
    to_jsonb((SELECT count(*) FROM jsonb_object_keys(map_knowledge->'sectors_visited')))
  )
  WHERE character_id = ANY(v_char_ids);
END $alpha_target_sectors$;

-- Backdate first_visit and created_at so the join is_first_visit heuristic (|last_active - first_visit| < 3m) returns false.
-- The update_character_last_active trigger refreshes last_active to NOW() on every UPDATE, which is what we want.
UPDATE characters SET first_visit = NOW() - INTERVAL '1 day', created_at = NOW() - INTERVAL '1 day' WHERE character_id IN (
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-1000-4000-8000-000000000001',
  'a0000000-2000-4000-8000-000000000001',
  'a0000000-3000-4000-8000-000000000001',
  'a0000000-4000-4000-8000-000000000001',
  'a0000000-5000-4000-8000-000000000001',
  'a0000000-6000-4000-8000-000000000001',
  'a0000000-7000-4000-8000-000000000001',
  'a0000000-8000-4000-8000-000000000001',
  'a0000000-9000-4000-8000-000000000001'
);

COMMIT;
