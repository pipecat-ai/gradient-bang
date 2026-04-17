-- Alpha Sparrow Eval — fresh character with sparrow_scout
-- Seeds 5 variations (Eval0..Eval4) with slot-indexed character & ship UUIDs
-- Usage: psql $LOCAL_API_POSTGRES_URL -f seeds/alpha_sparrow.sql

BEGIN;

-- Teardown all 5 variations
DELETE FROM events WHERE character_id IN (
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-1000-4000-8000-000000000001',
  'a0000000-2000-4000-8000-000000000001',
  'a0000000-3000-4000-8000-000000000001',
  'a0000000-4000-4000-8000-000000000001'
);
DELETE FROM events WHERE ship_id IN (
  SELECT ship_id FROM ship_instances WHERE owner_character_id IN (
    'a0000000-0000-4000-8000-000000000001',
    'a0000000-1000-4000-8000-000000000001',
    'a0000000-2000-4000-8000-000000000001',
    'a0000000-3000-4000-8000-000000000001',
    'a0000000-4000-4000-8000-000000000001'
  )
);
DELETE FROM user_characters
WHERE user_id = '352373e1-aa29-49c7-b929-2cba86ca4a3c'
  AND character_id IN (
    'a0000000-0000-4000-8000-000000000001',
    'a0000000-1000-4000-8000-000000000001',
    'a0000000-2000-4000-8000-000000000001',
    'a0000000-3000-4000-8000-000000000001',
    'a0000000-4000-4000-8000-000000000001'
  );
UPDATE characters SET current_ship_id = NULL WHERE character_id IN (
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-1000-4000-8000-000000000001',
  'a0000000-2000-4000-8000-000000000001',
  'a0000000-3000-4000-8000-000000000001',
  'a0000000-4000-4000-8000-000000000001'
);
DELETE FROM ship_instances WHERE owner_character_id IN (
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-1000-4000-8000-000000000001',
  'a0000000-2000-4000-8000-000000000001',
  'a0000000-3000-4000-8000-000000000001',
  'a0000000-4000-4000-8000-000000000001'
);
DELETE FROM characters WHERE character_id IN (
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-1000-4000-8000-000000000001',
  'a0000000-2000-4000-8000-000000000001',
  'a0000000-3000-4000-8000-000000000001',
  'a0000000-4000-4000-8000-000000000001'
);

-- Seed 5 variations
INSERT INTO characters (character_id, name, map_knowledge) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'Alpha Sparrow Eval0', '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('a0000000-1000-4000-8000-000000000001', 'Alpha Sparrow Eval1', '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('a0000000-2000-4000-8000-000000000001', 'Alpha Sparrow Eval2', '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('a0000000-3000-4000-8000-000000000001', 'Alpha Sparrow Eval3', '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('a0000000-4000-4000-8000-000000000001', 'Alpha Sparrow Eval4', '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}');

INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES
  ('a0000000-0000-4000-8000-a00000000001', 'a0000000-0000-4000-8000-000000000001', 'character', 'a0000000-0000-4000-8000-000000000001', 'sparrow_scout', 0, 5000, 450, 120, 200),
  ('a0000000-1000-4000-8000-a00000000001', 'a0000000-1000-4000-8000-000000000001', 'character', 'a0000000-1000-4000-8000-000000000001', 'sparrow_scout', 0, 5000, 450, 120, 200),
  ('a0000000-2000-4000-8000-a00000000001', 'a0000000-2000-4000-8000-000000000001', 'character', 'a0000000-2000-4000-8000-000000000001', 'sparrow_scout', 0, 5000, 450, 120, 200),
  ('a0000000-3000-4000-8000-a00000000001', 'a0000000-3000-4000-8000-000000000001', 'character', 'a0000000-3000-4000-8000-000000000001', 'sparrow_scout', 0, 5000, 450, 120, 200),
  ('a0000000-4000-4000-8000-a00000000001', 'a0000000-4000-4000-8000-000000000001', 'character', 'a0000000-4000-4000-8000-000000000001', 'sparrow_scout', 0, 5000, 450, 120, 200);

UPDATE characters SET current_ship_id = 'a0000000-0000-4000-8000-a00000000001' WHERE character_id = 'a0000000-0000-4000-8000-000000000001';
UPDATE characters SET current_ship_id = 'a0000000-1000-4000-8000-a00000000001' WHERE character_id = 'a0000000-1000-4000-8000-000000000001';
UPDATE characters SET current_ship_id = 'a0000000-2000-4000-8000-a00000000001' WHERE character_id = 'a0000000-2000-4000-8000-000000000001';
UPDATE characters SET current_ship_id = 'a0000000-3000-4000-8000-a00000000001' WHERE character_id = 'a0000000-3000-4000-8000-000000000001';
UPDATE characters SET current_ship_id = 'a0000000-4000-4000-8000-a00000000001' WHERE character_id = 'a0000000-4000-4000-8000-000000000001';

INSERT INTO user_characters (user_id, character_id) VALUES
  ('352373e1-aa29-49c7-b929-2cba86ca4a3c', 'a0000000-0000-4000-8000-000000000001'),
  ('352373e1-aa29-49c7-b929-2cba86ca4a3c', 'a0000000-1000-4000-8000-000000000001'),
  ('352373e1-aa29-49c7-b929-2cba86ca4a3c', 'a0000000-2000-4000-8000-000000000001'),
  ('352373e1-aa29-49c7-b929-2cba86ca4a3c', 'a0000000-3000-4000-8000-000000000001'),
  ('352373e1-aa29-49c7-b929-2cba86ca4a3c', 'a0000000-4000-4000-8000-000000000001');

COMMIT;
