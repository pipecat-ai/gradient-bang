-- Seed all eval characters (idempotent — safe to re-run)
-- Usage: psql $LOCAL_API_POSTGRES_URL -f seed_eval_characters.sql
-- To reset a single character: psql $LOCAL_API_POSTGRES_URL -f seeds/<name>.sql

-- Full teardown in one transaction, correct FK order
BEGIN;

-- 1. Remove user-character links
DELETE FROM user_characters WHERE user_id = '352373e1-aa29-49c7-b929-2cba86ca4a3c'
  AND character_id IN (
    'a0000000-0000-4000-8000-000000000001',
    'b0000000-0000-4000-8000-000000000002',
    'c0000000-0000-4000-8000-000000000003',
    'd0000000-0000-4000-8000-000000000004',
    'e0000000-0000-4000-8000-000000000005'
  );
DELETE FROM user_characters WHERE user_id = 'cf73d883-41fd-4fc5-ba5d-b82241d26ca7'
  AND character_id = 'f0000000-0000-4000-8000-000000000006';

-- 2. Delete events referencing eval characters' ships
DELETE FROM events WHERE ship_id IN (
  SELECT ship_id FROM ship_instances WHERE owner_character_id IN (
    'a0000000-0000-4000-8000-000000000001',
    'b0000000-0000-4000-8000-000000000002',
    'c0000000-0000-4000-8000-000000000003',
    'd0000000-0000-4000-8000-000000000004',
    'e0000000-0000-4000-8000-000000000005',
    'f0000000-0000-4000-8000-000000000006'
  )
);
DELETE FROM events WHERE ship_id IN (
  SELECT ship_id FROM ship_instances WHERE owner_corporation_id IN (
    'e0000000-0000-4000-8000-c00b00000001',
    'f0000000-0000-4000-8000-c00b00000002'
  )
);
DELETE FROM events WHERE character_id IN (
  'a0000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000002',
  'c0000000-0000-4000-8000-000000000003',
  'd0000000-0000-4000-8000-000000000004',
  'e0000000-0000-4000-8000-000000000005',
  'f0000000-0000-4000-8000-000000000006'
);

-- 3. Null out ship refs on characters
UPDATE characters SET current_ship_id = NULL WHERE character_id IN (
  'a0000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000002',
  'c0000000-0000-4000-8000-000000000003',
  'd0000000-0000-4000-8000-000000000004',
  'e0000000-0000-4000-8000-000000000005',
  'f0000000-0000-4000-8000-000000000006'
);

-- 3b. Delete corp ship/member associations
DELETE FROM corporation_ships WHERE corp_id IN (
  'e0000000-0000-4000-8000-c00b00000001',
  'f0000000-0000-4000-8000-c00b00000002'
);
DELETE FROM corporation_members WHERE corp_id IN (
  'e0000000-0000-4000-8000-c00b00000001',
  'f0000000-0000-4000-8000-c00b00000002'
);

-- 4. Delete all eval ships (character-owned and corp-owned)
DELETE FROM ship_instances WHERE owner_character_id IN (
  'a0000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000002',
  'c0000000-0000-4000-8000-000000000003',
  'd0000000-0000-4000-8000-000000000004',
  'e0000000-0000-4000-8000-000000000005',
  'f0000000-0000-4000-8000-000000000006'
);
DELETE FROM ship_instances WHERE owner_corporation_id IN (
  'e0000000-0000-4000-8000-c00b00000001',
  'f0000000-0000-4000-8000-c00b00000002'
);

-- 5. Null out corp refs on characters, then delete corps before characters
UPDATE characters SET corporation_id = NULL WHERE corporation_id IN (
  'e0000000-0000-4000-8000-c00b00000001',
  'f0000000-0000-4000-8000-c00b00000002'
);
DELETE FROM corporations WHERE corp_id IN (
  'e0000000-0000-4000-8000-c00b00000001',
  'f0000000-0000-4000-8000-c00b00000002'
);

-- 6. Delete characters
DELETE FROM characters WHERE character_id IN (
  'a0000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000002',
  'c0000000-0000-4000-8000-000000000003',
  'd0000000-0000-4000-8000-000000000004',
  'e0000000-0000-4000-8000-000000000005',
  'f0000000-0000-4000-8000-000000000006'
);

-- === SEED ===

-- Alpha Sparrow Eval — fresh character with sparrow_scout
INSERT INTO characters (character_id, name, map_knowledge)
VALUES (
  'a0000000-0000-4000-8000-000000000001',
  'Alpha Sparrow Eval',
  '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'
);

INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES (
  'a0000000-0000-4000-8000-a00000000001',
  'a0000000-0000-4000-8000-000000000001', 'character', 'a0000000-0000-4000-8000-000000000001',
  'sparrow_scout', 0, 5000,
  450, 120, 200
);

UPDATE characters
SET current_ship_id = 'a0000000-0000-4000-8000-a00000000001'
WHERE character_id = 'a0000000-0000-4000-8000-000000000001';

-- Beta Kestrel Eval — kestrel_courier, 10k on ship, 5k in megabank
INSERT INTO characters (character_id, name, credits_in_megabank, map_knowledge)
VALUES (
  'b0000000-0000-4000-8000-000000000002',
  'Beta Kestrel Eval',
  5000,
  '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'
);

INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES (
  'b0000000-0000-4000-8000-b00000000002',
  'b0000000-0000-4000-8000-000000000002', 'character', 'b0000000-0000-4000-8000-000000000002',
  'kestrel_courier', 0, 10000,
  500, 150, 300
);

UPDATE characters
SET current_ship_id = 'b0000000-0000-4000-8000-b00000000002'
WHERE character_id = 'b0000000-0000-4000-8000-000000000002';

-- Gamma Explorer Eval — well-explored character, visited 40 sectors
INSERT INTO characters (character_id, name, credits_in_megabank, map_knowledge)
VALUES (
  'c0000000-0000-4000-8000-000000000003',
  'Gamma Explorer Eval',
  20000,
  '{
    "total_sectors_visited": 40,
    "sectors_visited": {
      "0":  {"adjacent_sectors": [15], "last_visited": "2026-04-01T10:00:00Z", "position": [15, 31]},
      "1":  {"adjacent_sectors": [12, 15, 26], "last_visited": "2026-04-01T10:05:00Z", "position": [12, 26]},
      "2":  {"adjacent_sectors": [5, 8], "last_visited": "2026-04-01T10:10:00Z", "position": [10, 20]},
      "3":  {"adjacent_sectors": [7, 11], "last_visited": "2026-04-01T10:15:00Z", "position": [8, 18]},
      "4":  {"adjacent_sectors": [9, 14], "last_visited": "2026-04-01T10:20:00Z", "position": [6, 22]},
      "5":  {"adjacent_sectors": [2, 10], "last_visited": "2026-04-01T10:25:00Z", "position": [11, 19]},
      "6":  {"adjacent_sectors": [13, 18], "last_visited": "2026-04-01T10:30:00Z", "position": [14, 25]},
      "7":  {"adjacent_sectors": [3, 16], "last_visited": "2026-04-01T10:35:00Z", "position": [7, 17]},
      "8":  {"adjacent_sectors": [2, 19], "last_visited": "2026-04-01T10:40:00Z", "position": [9, 21]},
      "9":  {"adjacent_sectors": [4, 20], "last_visited": "2026-04-01T10:45:00Z", "position": [5, 23]},
      "10": {"adjacent_sectors": [5, 21], "last_visited": "2026-04-01T11:00:00Z", "position": [12, 18]},
      "11": {"adjacent_sectors": [3, 22], "last_visited": "2026-04-01T11:05:00Z", "position": [7, 16]},
      "12": {"adjacent_sectors": [1, 23], "last_visited": "2026-04-01T11:10:00Z", "position": [13, 27]},
      "13": {"adjacent_sectors": [6, 24], "last_visited": "2026-04-01T11:15:00Z", "position": [15, 24]},
      "14": {"adjacent_sectors": [4, 25], "last_visited": "2026-04-01T11:20:00Z", "position": [5, 21]},
      "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-01T11:25:00Z", "position": [16, 30]},
      "16": {"adjacent_sectors": [7, 26], "last_visited": "2026-04-01T11:30:00Z", "position": [6, 15]},
      "17": {"adjacent_sectors": [27, 30], "last_visited": "2026-04-02T10:00:00Z", "position": [20, 14]},
      "18": {"adjacent_sectors": [6, 28], "last_visited": "2026-04-02T10:05:00Z", "position": [15, 26]},
      "19": {"adjacent_sectors": [8, 29], "last_visited": "2026-04-02T10:10:00Z", "position": [10, 22]},
      "20": {"adjacent_sectors": [9, 31], "last_visited": "2026-04-02T10:15:00Z", "position": [4, 24]},
      "21": {"adjacent_sectors": [10, 32], "last_visited": "2026-04-02T10:20:00Z", "position": [13, 17]},
      "22": {"adjacent_sectors": [11, 33], "last_visited": "2026-04-02T10:25:00Z", "position": [6, 14]},
      "23": {"adjacent_sectors": [12, 34], "last_visited": "2026-04-02T10:30:00Z", "position": [14, 28]},
      "24": {"adjacent_sectors": [13, 35], "last_visited": "2026-04-02T10:35:00Z", "position": [16, 23]},
      "25": {"adjacent_sectors": [14, 36], "last_visited": "2026-04-02T10:40:00Z", "position": [4, 20]},
      "26": {"adjacent_sectors": [1, 16], "last_visited": "2026-04-02T10:45:00Z", "position": [11, 25]},
      "27": {"adjacent_sectors": [17, 37], "last_visited": "2026-04-02T11:00:00Z", "position": [21, 13]},
      "28": {"adjacent_sectors": [18, 38], "last_visited": "2026-04-02T11:05:00Z", "position": [16, 27]},
      "29": {"adjacent_sectors": [19, 39], "last_visited": "2026-04-02T11:10:00Z", "position": [11, 23]},
      "30": {"adjacent_sectors": [17, 40], "last_visited": "2026-04-03T10:00:00Z", "position": [22, 15]},
      "31": {"adjacent_sectors": [20, 41], "last_visited": "2026-04-03T10:05:00Z", "position": [3, 25]},
      "32": {"adjacent_sectors": [21, 42], "last_visited": "2026-04-03T10:10:00Z", "position": [14, 16]},
      "33": {"adjacent_sectors": [22, 43], "last_visited": "2026-04-03T10:15:00Z", "position": [5, 13]},
      "34": {"adjacent_sectors": [23, 44], "last_visited": "2026-04-03T10:20:00Z", "position": [15, 29]},
      "35": {"adjacent_sectors": [24, 45], "last_visited": "2026-04-03T10:25:00Z", "position": [17, 22]},
      "36": {"adjacent_sectors": [25, 46], "last_visited": "2026-04-03T10:30:00Z", "position": [3, 19]},
      "37": {"adjacent_sectors": [27, 47], "last_visited": "2026-04-03T10:35:00Z", "position": [22, 12]},
      "38": {"adjacent_sectors": [28, 48], "last_visited": "2026-04-03T10:40:00Z", "position": [17, 28]},
      "39": {"adjacent_sectors": [29, 49], "last_visited": "2026-04-03T10:45:00Z", "position": [12, 24]}
    }
  }'
);

INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES (
  'c0000000-0000-4000-8000-c00000000003',
  'c0000000-0000-4000-8000-000000000003', 'character', 'c0000000-0000-4000-8000-000000000003',
  'parhelion_seeker', 37, 15000,
  600, 180, 400
);

UPDATE characters
SET current_ship_id = 'c0000000-0000-4000-8000-c00000000003'
WHERE character_id = 'c0000000-0000-4000-8000-000000000003';

-- Delta Fleet Eval — multiple ships, active in a wayfarer_freighter
INSERT INTO characters (character_id, name, credits_in_megabank, map_knowledge)
VALUES (
  'd0000000-0000-4000-8000-000000000004',
  'Delta Fleet Eval',
  50000,
  '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'
);

INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES (
  'd0000000-0000-4000-8000-d00000000001',
  'd0000000-0000-4000-8000-000000000004', 'character', 'd0000000-0000-4000-8000-000000000004',
  'wayfarer_freighter', 0, 30000,
  800, 300, 600
);

INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES (
  'd0000000-0000-4000-8000-d00000000002',
  'd0000000-0000-4000-8000-000000000004', 'character', 'd0000000-0000-4000-8000-000000000004',
  'corsair_raider', 42, 5000,
  700, 400, 1500
);

INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES (
  'd0000000-0000-4000-8000-d00000000003',
  'd0000000-0000-4000-8000-000000000004', 'character', 'd0000000-0000-4000-8000-000000000004',
  'kestrel_courier', 15, 0,
  500, 150, 300
);

UPDATE characters
SET current_ship_id = 'd0000000-0000-4000-8000-d00000000001'
WHERE character_id = 'd0000000-0000-4000-8000-000000000004';

-- Epsilon Corp Eval — character with a corporation-owned ship
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

INSERT INTO corporation_members (corp_id, character_id)
VALUES ('e0000000-0000-4000-8000-c00b00000001', 'e0000000-0000-4000-8000-000000000005');

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

INSERT INTO corporation_ships (corp_id, ship_id, added_by)
VALUES ('e0000000-0000-4000-8000-c00b00000001', 'e0000000-0000-4000-8000-e00000000002', 'e0000000-0000-4000-8000-000000000005');

UPDATE characters
SET current_ship_id = 'e0000000-0000-4000-8000-e00000000001'
WHERE character_id = 'e0000000-0000-4000-8000-000000000005';

-- Phi Trader Eval — corp member with personal kestrel + two corp ships (credit transfer evals)
INSERT INTO characters (character_id, name, credits_in_megabank, map_knowledge)
VALUES (
  'f0000000-0000-4000-8000-000000000006',
  'Phi Trader Eval',
  25000,
  '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'
);

INSERT INTO corporations (corp_id, name, founder_id, invite_code)
VALUES (
  'f0000000-0000-4000-8000-c00b00000002',
  'Phi Trading Co',
  'f0000000-0000-4000-8000-000000000006',
  'PHITRADE'
);

UPDATE characters
SET corporation_id = 'f0000000-0000-4000-8000-c00b00000002'
WHERE character_id = 'f0000000-0000-4000-8000-000000000006';

INSERT INTO corporation_members (corp_id, character_id)
VALUES ('f0000000-0000-4000-8000-c00b00000002', 'f0000000-0000-4000-8000-000000000006');

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

INSERT INTO corporation_ships (corp_id, ship_id, added_by)
VALUES
  ('f0000000-0000-4000-8000-c00b00000002', 'f0000000-0000-4000-8000-f00000000002', 'f0000000-0000-4000-8000-000000000006'),
  ('f0000000-0000-4000-8000-c00b00000002', 'f0000000-0000-4000-8000-f00000000003', 'f0000000-0000-4000-8000-000000000006');

UPDATE characters
SET current_ship_id = 'f0000000-0000-4000-8000-f00000000001'
WHERE character_id = 'f0000000-0000-4000-8000-000000000006';

-- Link all to eval user
INSERT INTO user_characters (user_id, character_id) VALUES
  ('352373e1-aa29-49c7-b929-2cba86ca4a3c', 'a0000000-0000-4000-8000-000000000001'),
  ('352373e1-aa29-49c7-b929-2cba86ca4a3c', 'b0000000-0000-4000-8000-000000000002'),
  ('352373e1-aa29-49c7-b929-2cba86ca4a3c', 'c0000000-0000-4000-8000-000000000003'),
  ('352373e1-aa29-49c7-b929-2cba86ca4a3c', 'd0000000-0000-4000-8000-000000000004'),
  ('352373e1-aa29-49c7-b929-2cba86ca4a3c', 'e0000000-0000-4000-8000-000000000005'),
  ('cf73d883-41fd-4fc5-ba5d-b82241d26ca7', 'f0000000-0000-4000-8000-000000000006');

COMMIT;
