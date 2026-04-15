-- Epsilon Corp Eval — character with a corporation-owned ship
-- Usage: psql $LOCAL_API_POSTGRES_URL -f seeds/epsilon_corp.sql
-- Note: depends on Alpha Sparrow existing (corp founder). Seeds it if missing.


BEGIN;

-- Teardown epsilon
DELETE FROM events WHERE character_id = 'e0000000-0000-4000-8000-000000000005';
DELETE FROM events WHERE ship_id IN (
  SELECT ship_id FROM ship_instances WHERE owner_character_id = 'e0000000-0000-4000-8000-000000000005'
);
DELETE FROM events WHERE ship_id IN (
  SELECT ship_id FROM ship_instances WHERE owner_corporation_id = 'e0000000-0000-4000-8000-c00b00000001'
);
DELETE FROM corporation_ships WHERE corp_id = 'e0000000-0000-4000-8000-c00b00000001';
DELETE FROM corporation_members WHERE corp_id = 'e0000000-0000-4000-8000-c00b00000001';
DELETE FROM user_characters
WHERE user_id = '352373e1-aa29-49c7-b929-2cba86ca4a3c'
  AND character_id = 'e0000000-0000-4000-8000-000000000005';
UPDATE characters SET current_ship_id = NULL WHERE character_id = 'e0000000-0000-4000-8000-000000000005';
DELETE FROM ship_instances WHERE owner_character_id = 'e0000000-0000-4000-8000-000000000005';
DELETE FROM ship_instances WHERE owner_corporation_id = 'e0000000-0000-4000-8000-c00b00000001';
UPDATE characters SET corporation_id = NULL WHERE character_id = 'e0000000-0000-4000-8000-000000000005';
DELETE FROM characters WHERE character_id = 'e0000000-0000-4000-8000-000000000005';
DELETE FROM corporations WHERE corp_id = 'e0000000-0000-4000-8000-c00b00000001';

-- Ensure Alpha Sparrow exists (corp founder dependency)
INSERT INTO characters (character_id, name)
VALUES ('a0000000-0000-4000-8000-000000000001', 'Alpha Sparrow Eval')
ON CONFLICT (character_id) DO NOTHING;

-- Create the corporation (founded by Alpha Sparrow)
INSERT INTO corporations (corp_id, name, founder_id, invite_code)
VALUES (
  'e0000000-0000-4000-8000-c00b00000001',
  'Eval Corp',
  'a0000000-0000-4000-8000-000000000001',
  'EVALCORP'
);

INSERT INTO characters (character_id, name, credits_in_megabank, corporation_id, map_knowledge)
VALUES (
  'e0000000-0000-4000-8000-000000000005',
  'Epsilon Corp Eval',
  8000,
  'e0000000-0000-4000-8000-c00b00000001',
  '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'
);

-- Corporation membership
INSERT INTO corporation_members (corp_id, character_id)
VALUES ('e0000000-0000-4000-8000-c00b00000001', 'e0000000-0000-4000-8000-000000000005');

-- Personal ship
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES (
  'e0000000-0000-4000-8000-e00000000001',
  'e0000000-0000-4000-8000-000000000005', 'character', 'e0000000-0000-4000-8000-000000000005',
  'sparrow_scout', 0, 3000,
  450, 120, 200
);

-- Corporation-owned ship
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_corporation_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES (
  'e0000000-0000-4000-8000-e00000000002',
  'e0000000-0000-4000-8000-c00b00000001', 'corporation', 'e0000000-0000-4000-8000-c00b00000001',
  'pike_frigate', 0, 20000,
  900, 600, 2000
);

-- Register corp ship
INSERT INTO corporation_ships (corp_id, ship_id, added_by)
VALUES ('e0000000-0000-4000-8000-c00b00000001', 'e0000000-0000-4000-8000-e00000000002', 'e0000000-0000-4000-8000-000000000005');

UPDATE characters
SET current_ship_id = 'e0000000-0000-4000-8000-e00000000001'
WHERE character_id = 'e0000000-0000-4000-8000-000000000005';

INSERT INTO user_characters (user_id, character_id)
VALUES ('352373e1-aa29-49c7-b929-2cba86ca4a3c', 'e0000000-0000-4000-8000-000000000005');

COMMIT;
