-- Gamma Explorer Eval — well-explored character, visited 40 sectors
-- Usage: psql $LOCAL_API_POSTGRES_URL -f seeds/gamma_explorer.sql

BEGIN;

DELETE FROM events WHERE character_id = 'c0000000-0000-4000-8000-000000000003';
DELETE FROM events WHERE ship_id IN (
  SELECT ship_id FROM ship_instances WHERE owner_character_id = 'c0000000-0000-4000-8000-000000000003'
);
DELETE FROM user_characters
WHERE user_id = '352373e1-aa29-49c7-b929-2cba86ca4a3c'
  AND character_id = 'c0000000-0000-4000-8000-000000000003';
DELETE FROM ship_instances WHERE owner_character_id = 'c0000000-0000-4000-8000-000000000003';
UPDATE characters SET current_ship_id = NULL WHERE character_id = 'c0000000-0000-4000-8000-000000000003';
DELETE FROM characters WHERE character_id = 'c0000000-0000-4000-8000-000000000003';

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

INSERT INTO user_characters (user_id, character_id)
VALUES ('352373e1-aa29-49c7-b929-2cba86ca4a3c', 'c0000000-0000-4000-8000-000000000003');

COMMIT;
