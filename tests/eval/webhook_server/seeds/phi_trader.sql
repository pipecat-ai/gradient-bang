-- Phi Trader Eval — corp member with personal kestrel_courier + two corp ships
-- Designed for credit transfer evals: corp-to-personal, corp-to-corp
-- Usage: psql $LOCAL_API_POSTGRES_URL -f seeds/phi_trader.sql
-- Note: creates its own corporation (Phi Trading Co)

BEGIN;

-- Teardown
DELETE FROM events WHERE character_id = 'f0000000-0000-4000-8000-000000000006';
DELETE FROM events WHERE ship_id IN (
  SELECT ship_id FROM ship_instances WHERE owner_character_id = 'f0000000-0000-4000-8000-000000000006'
);
DELETE FROM events WHERE ship_id IN (
  SELECT ship_id FROM ship_instances WHERE owner_corporation_id = 'f0000000-0000-4000-8000-c00b00000002'
);
DELETE FROM corporation_ships WHERE corp_id = 'f0000000-0000-4000-8000-c00b00000002';
DELETE FROM corporation_members WHERE corp_id = 'f0000000-0000-4000-8000-c00b00000002';
DELETE FROM user_characters
WHERE user_id = 'cf73d883-41fd-4fc5-ba5d-b82241d26ca7'
  AND character_id = 'f0000000-0000-4000-8000-000000000006';
DELETE FROM ship_instances WHERE owner_character_id = 'f0000000-0000-4000-8000-000000000006';
DELETE FROM ship_instances WHERE owner_corporation_id = 'f0000000-0000-4000-8000-c00b00000002';
UPDATE characters SET current_ship_id = NULL WHERE character_id = 'f0000000-0000-4000-8000-000000000006';
UPDATE characters SET corporation_id = NULL WHERE character_id = 'f0000000-0000-4000-8000-000000000006';
DELETE FROM characters WHERE character_id = 'f0000000-0000-4000-8000-000000000006';
DELETE FROM corporations WHERE corp_id = 'f0000000-0000-4000-8000-c00b00000002';

-- Character first (founder must exist before corporation references it)
INSERT INTO characters (character_id, name, credits_in_megabank, map_knowledge)
VALUES (
  'f0000000-0000-4000-8000-000000000006',
  'Phi Trader Eval',
  25000,
  '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'
);

-- Corporation (founder must already exist)
INSERT INTO corporations (corp_id, name, founder_id, invite_code)
VALUES (
  'f0000000-0000-4000-8000-c00b00000002',
  'Phi Trading Co',
  'f0000000-0000-4000-8000-000000000006',
  'PHITRADE'
);

-- Set corporation_id on character now that corp exists
UPDATE characters
SET corporation_id = 'f0000000-0000-4000-8000-c00b00000002'
WHERE character_id = 'f0000000-0000-4000-8000-000000000006';

-- Corporation membership
INSERT INTO corporation_members (corp_id, character_id)
VALUES ('f0000000-0000-4000-8000-c00b00000002', 'f0000000-0000-4000-8000-000000000006');

-- Personal ship: kestrel_courier in sector 0, 5k credits
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES (
  'f0000000-0000-4000-8000-f00000000001',
  'f0000000-0000-4000-8000-000000000006', 'character', 'f0000000-0000-4000-8000-000000000006',
  'kestrel_courier', 0, 5000,
  500, 150, 300
);

-- Corp ship 1: wayfarer_freighter in sector 0, 30k credits
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_corporation_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES (
  'f0000000-0000-4000-8000-f00000000002',
  'f0000000-0000-4000-8000-c00b00000002', 'corporation', 'f0000000-0000-4000-8000-c00b00000002',
  'wayfarer_freighter', 0, 30000,
  800, 300, 600
);

-- Corp ship 2: autonomous_light_hauler in sector 15, 15k credits
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_corporation_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES (
  'f0000000-0000-4000-8000-f00000000003',
  'f0000000-0000-4000-8000-c00b00000002', 'corporation', 'f0000000-0000-4000-8000-c00b00000002',
  'autonomous_light_hauler', 15, 15000,
  200, 0, 0
);

-- Register corp ships
INSERT INTO corporation_ships (corp_id, ship_id, added_by)
VALUES
  ('f0000000-0000-4000-8000-c00b00000002', 'f0000000-0000-4000-8000-f00000000002', 'f0000000-0000-4000-8000-000000000006'),
  ('f0000000-0000-4000-8000-c00b00000002', 'f0000000-0000-4000-8000-f00000000003', 'f0000000-0000-4000-8000-000000000006');

-- Set active ship
UPDATE characters
SET current_ship_id = 'f0000000-0000-4000-8000-f00000000001'
WHERE character_id = 'f0000000-0000-4000-8000-000000000006';

-- Link to eval user
INSERT INTO user_characters (user_id, character_id)
VALUES ('cf73d883-41fd-4fc5-ba5d-b82241d26ca7', 'f0000000-0000-4000-8000-000000000006');

COMMIT;
