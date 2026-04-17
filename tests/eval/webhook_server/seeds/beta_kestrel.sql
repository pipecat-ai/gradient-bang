-- Beta Kestrel Eval — kestrel_courier, 10k on ship, 5k in megabank
-- Seeds 5 variations (Eval0..Eval4) with slot-indexed character & ship UUIDs
-- Usage: psql $LOCAL_API_POSTGRES_URL -f seeds/beta_kestrel.sql

BEGIN;

DELETE FROM events WHERE character_id IN (
  'b0000000-0000-4000-8000-000000000002',
  'b0000000-1000-4000-8000-000000000002',
  'b0000000-2000-4000-8000-000000000002',
  'b0000000-3000-4000-8000-000000000002',
  'b0000000-4000-4000-8000-000000000002'
);
DELETE FROM events WHERE ship_id IN (
  SELECT ship_id FROM ship_instances WHERE owner_character_id IN (
    'b0000000-0000-4000-8000-000000000002',
    'b0000000-1000-4000-8000-000000000002',
    'b0000000-2000-4000-8000-000000000002',
    'b0000000-3000-4000-8000-000000000002',
    'b0000000-4000-4000-8000-000000000002'
  )
);
DELETE FROM user_characters
WHERE user_id = '352373e1-aa29-49c7-b929-2cba86ca4a3c'
  AND character_id IN (
    'b0000000-0000-4000-8000-000000000002',
    'b0000000-1000-4000-8000-000000000002',
    'b0000000-2000-4000-8000-000000000002',
    'b0000000-3000-4000-8000-000000000002',
    'b0000000-4000-4000-8000-000000000002'
  );
UPDATE characters SET current_ship_id = NULL WHERE character_id IN (
  'b0000000-0000-4000-8000-000000000002',
  'b0000000-1000-4000-8000-000000000002',
  'b0000000-2000-4000-8000-000000000002',
  'b0000000-3000-4000-8000-000000000002',
  'b0000000-4000-4000-8000-000000000002'
);
DELETE FROM ship_instances WHERE owner_character_id IN (
  'b0000000-0000-4000-8000-000000000002',
  'b0000000-1000-4000-8000-000000000002',
  'b0000000-2000-4000-8000-000000000002',
  'b0000000-3000-4000-8000-000000000002',
  'b0000000-4000-4000-8000-000000000002'
);
DELETE FROM characters WHERE character_id IN (
  'b0000000-0000-4000-8000-000000000002',
  'b0000000-1000-4000-8000-000000000002',
  'b0000000-2000-4000-8000-000000000002',
  'b0000000-3000-4000-8000-000000000002',
  'b0000000-4000-4000-8000-000000000002'
);

INSERT INTO characters (character_id, name, credits_in_megabank, map_knowledge) VALUES
  ('b0000000-0000-4000-8000-000000000002', 'Beta Kestrel Eval0', 5000, '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('b0000000-1000-4000-8000-000000000002', 'Beta Kestrel Eval1', 5000, '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('b0000000-2000-4000-8000-000000000002', 'Beta Kestrel Eval2', 5000, '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('b0000000-3000-4000-8000-000000000002', 'Beta Kestrel Eval3', 5000, '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('b0000000-4000-4000-8000-000000000002', 'Beta Kestrel Eval4', 5000, '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}');

INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES
  ('b0000000-0000-4000-8000-b00000000002', 'b0000000-0000-4000-8000-000000000002', 'character', 'b0000000-0000-4000-8000-000000000002', 'kestrel_courier', 0, 10000, 500, 150, 300),
  ('b0000000-1000-4000-8000-b00000000002', 'b0000000-1000-4000-8000-000000000002', 'character', 'b0000000-1000-4000-8000-000000000002', 'kestrel_courier', 0, 10000, 500, 150, 300),
  ('b0000000-2000-4000-8000-b00000000002', 'b0000000-2000-4000-8000-000000000002', 'character', 'b0000000-2000-4000-8000-000000000002', 'kestrel_courier', 0, 10000, 500, 150, 300),
  ('b0000000-3000-4000-8000-b00000000002', 'b0000000-3000-4000-8000-000000000002', 'character', 'b0000000-3000-4000-8000-000000000002', 'kestrel_courier', 0, 10000, 500, 150, 300),
  ('b0000000-4000-4000-8000-b00000000002', 'b0000000-4000-4000-8000-000000000002', 'character', 'b0000000-4000-4000-8000-000000000002', 'kestrel_courier', 0, 10000, 500, 150, 300);

UPDATE characters SET current_ship_id = 'b0000000-0000-4000-8000-b00000000002' WHERE character_id = 'b0000000-0000-4000-8000-000000000002';
UPDATE characters SET current_ship_id = 'b0000000-1000-4000-8000-b00000000002' WHERE character_id = 'b0000000-1000-4000-8000-000000000002';
UPDATE characters SET current_ship_id = 'b0000000-2000-4000-8000-b00000000002' WHERE character_id = 'b0000000-2000-4000-8000-000000000002';
UPDATE characters SET current_ship_id = 'b0000000-3000-4000-8000-b00000000002' WHERE character_id = 'b0000000-3000-4000-8000-000000000002';
UPDATE characters SET current_ship_id = 'b0000000-4000-4000-8000-b00000000002' WHERE character_id = 'b0000000-4000-4000-8000-000000000002';

INSERT INTO user_characters (user_id, character_id) VALUES
  ('352373e1-aa29-49c7-b929-2cba86ca4a3c', 'b0000000-0000-4000-8000-000000000002'),
  ('352373e1-aa29-49c7-b929-2cba86ca4a3c', 'b0000000-1000-4000-8000-000000000002'),
  ('352373e1-aa29-49c7-b929-2cba86ca4a3c', 'b0000000-2000-4000-8000-000000000002'),
  ('352373e1-aa29-49c7-b929-2cba86ca4a3c', 'b0000000-3000-4000-8000-000000000002'),
  ('352373e1-aa29-49c7-b929-2cba86ca4a3c', 'b0000000-4000-4000-8000-000000000002');

COMMIT;
