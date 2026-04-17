-- Delta Fleet Eval — multiple ships, active in a wayfarer_freighter
-- Seeds 5 variations (Eval0..Eval4) with slot-indexed character & ship UUIDs
-- Usage: psql $LOCAL_API_POSTGRES_URL -f seeds/delta_fleet.sql

BEGIN;

DELETE FROM events WHERE character_id IN (
  'd0000000-0000-4000-8000-000000000004',
  'd0000000-1000-4000-8000-000000000004',
  'd0000000-2000-4000-8000-000000000004',
  'd0000000-3000-4000-8000-000000000004',
  'd0000000-4000-4000-8000-000000000004'
);
DELETE FROM events WHERE ship_id IN (
  SELECT ship_id FROM ship_instances WHERE owner_character_id IN (
    'd0000000-0000-4000-8000-000000000004',
    'd0000000-1000-4000-8000-000000000004',
    'd0000000-2000-4000-8000-000000000004',
    'd0000000-3000-4000-8000-000000000004',
    'd0000000-4000-4000-8000-000000000004'
  )
);
DELETE FROM user_characters
WHERE user_id = '352373e1-aa29-49c7-b929-2cba86ca4a3c'
  AND character_id IN (
    'd0000000-0000-4000-8000-000000000004',
    'd0000000-1000-4000-8000-000000000004',
    'd0000000-2000-4000-8000-000000000004',
    'd0000000-3000-4000-8000-000000000004',
    'd0000000-4000-4000-8000-000000000004'
  );
UPDATE characters SET current_ship_id = NULL WHERE character_id IN (
  'd0000000-0000-4000-8000-000000000004',
  'd0000000-1000-4000-8000-000000000004',
  'd0000000-2000-4000-8000-000000000004',
  'd0000000-3000-4000-8000-000000000004',
  'd0000000-4000-4000-8000-000000000004'
);
DELETE FROM ship_instances WHERE owner_character_id IN (
  'd0000000-0000-4000-8000-000000000004',
  'd0000000-1000-4000-8000-000000000004',
  'd0000000-2000-4000-8000-000000000004',
  'd0000000-3000-4000-8000-000000000004',
  'd0000000-4000-4000-8000-000000000004'
);
DELETE FROM characters WHERE character_id IN (
  'd0000000-0000-4000-8000-000000000004',
  'd0000000-1000-4000-8000-000000000004',
  'd0000000-2000-4000-8000-000000000004',
  'd0000000-3000-4000-8000-000000000004',
  'd0000000-4000-4000-8000-000000000004'
);

INSERT INTO characters (character_id, name, credits_in_megabank, map_knowledge) VALUES
  ('d0000000-0000-4000-8000-000000000004', 'Delta Fleet Eval0', 50000, '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'),
  ('d0000000-1000-4000-8000-000000000004', 'Delta Fleet Eval1', 50000, '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'),
  ('d0000000-2000-4000-8000-000000000004', 'Delta Fleet Eval2', 50000, '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'),
  ('d0000000-3000-4000-8000-000000000004', 'Delta Fleet Eval3', 50000, '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'),
  ('d0000000-4000-4000-8000-000000000004', 'Delta Fleet Eval4', 50000, '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}');

-- Wayfarer freighters (active ship)
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES
  ('d0000000-0000-4000-8000-d00000000001', 'd0000000-0000-4000-8000-000000000004', 'character', 'd0000000-0000-4000-8000-000000000004', 'wayfarer_freighter', 0, 30000, 800, 300, 600),
  ('d0000000-1000-4000-8000-d00000000001', 'd0000000-1000-4000-8000-000000000004', 'character', 'd0000000-1000-4000-8000-000000000004', 'wayfarer_freighter', 0, 30000, 800, 300, 600),
  ('d0000000-2000-4000-8000-d00000000001', 'd0000000-2000-4000-8000-000000000004', 'character', 'd0000000-2000-4000-8000-000000000004', 'wayfarer_freighter', 0, 30000, 800, 300, 600),
  ('d0000000-3000-4000-8000-d00000000001', 'd0000000-3000-4000-8000-000000000004', 'character', 'd0000000-3000-4000-8000-000000000004', 'wayfarer_freighter', 0, 30000, 800, 300, 600),
  ('d0000000-4000-4000-8000-d00000000001', 'd0000000-4000-4000-8000-000000000004', 'character', 'd0000000-4000-4000-8000-000000000004', 'wayfarer_freighter', 0, 30000, 800, 300, 600);

-- Corsair raiders (parked in sector 42)
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES
  ('d0000000-0000-4000-8000-d00000000002', 'd0000000-0000-4000-8000-000000000004', 'character', 'd0000000-0000-4000-8000-000000000004', 'corsair_raider', 42, 5000, 700, 400, 1500),
  ('d0000000-1000-4000-8000-d00000000002', 'd0000000-1000-4000-8000-000000000004', 'character', 'd0000000-1000-4000-8000-000000000004', 'corsair_raider', 42, 5000, 700, 400, 1500),
  ('d0000000-2000-4000-8000-d00000000002', 'd0000000-2000-4000-8000-000000000004', 'character', 'd0000000-2000-4000-8000-000000000004', 'corsair_raider', 42, 5000, 700, 400, 1500),
  ('d0000000-3000-4000-8000-d00000000002', 'd0000000-3000-4000-8000-000000000004', 'character', 'd0000000-3000-4000-8000-000000000004', 'corsair_raider', 42, 5000, 700, 400, 1500),
  ('d0000000-4000-4000-8000-d00000000002', 'd0000000-4000-4000-8000-000000000004', 'character', 'd0000000-4000-4000-8000-000000000004', 'corsair_raider', 42, 5000, 700, 400, 1500);

-- Kestrel couriers (parked in sector 15)
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES
  ('d0000000-0000-4000-8000-d00000000003', 'd0000000-0000-4000-8000-000000000004', 'character', 'd0000000-0000-4000-8000-000000000004', 'kestrel_courier', 15, 0, 500, 150, 300),
  ('d0000000-1000-4000-8000-d00000000003', 'd0000000-1000-4000-8000-000000000004', 'character', 'd0000000-1000-4000-8000-000000000004', 'kestrel_courier', 15, 0, 500, 150, 300),
  ('d0000000-2000-4000-8000-d00000000003', 'd0000000-2000-4000-8000-000000000004', 'character', 'd0000000-2000-4000-8000-000000000004', 'kestrel_courier', 15, 0, 500, 150, 300),
  ('d0000000-3000-4000-8000-d00000000003', 'd0000000-3000-4000-8000-000000000004', 'character', 'd0000000-3000-4000-8000-000000000004', 'kestrel_courier', 15, 0, 500, 150, 300),
  ('d0000000-4000-4000-8000-d00000000003', 'd0000000-4000-4000-8000-000000000004', 'character', 'd0000000-4000-4000-8000-000000000004', 'kestrel_courier', 15, 0, 500, 150, 300);

UPDATE characters SET current_ship_id = 'd0000000-0000-4000-8000-d00000000001' WHERE character_id = 'd0000000-0000-4000-8000-000000000004';
UPDATE characters SET current_ship_id = 'd0000000-1000-4000-8000-d00000000001' WHERE character_id = 'd0000000-1000-4000-8000-000000000004';
UPDATE characters SET current_ship_id = 'd0000000-2000-4000-8000-d00000000001' WHERE character_id = 'd0000000-2000-4000-8000-000000000004';
UPDATE characters SET current_ship_id = 'd0000000-3000-4000-8000-d00000000001' WHERE character_id = 'd0000000-3000-4000-8000-000000000004';
UPDATE characters SET current_ship_id = 'd0000000-4000-4000-8000-d00000000001' WHERE character_id = 'd0000000-4000-4000-8000-000000000004';

INSERT INTO user_characters (user_id, character_id) VALUES
  ('352373e1-aa29-49c7-b929-2cba86ca4a3c', 'd0000000-0000-4000-8000-000000000004'),
  ('352373e1-aa29-49c7-b929-2cba86ca4a3c', 'd0000000-1000-4000-8000-000000000004'),
  ('352373e1-aa29-49c7-b929-2cba86ca4a3c', 'd0000000-2000-4000-8000-000000000004'),
  ('352373e1-aa29-49c7-b929-2cba86ca4a3c', 'd0000000-3000-4000-8000-000000000004'),
  ('352373e1-aa29-49c7-b929-2cba86ca4a3c', 'd0000000-4000-4000-8000-000000000004');

COMMIT;
