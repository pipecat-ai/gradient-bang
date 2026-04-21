-- Gamma Explorer Eval — well-explored character, visited 40 sectors
-- Seeds 11 variations (Eval0..Eval10) with slot-indexed character & ship UUIDs.
-- Slots 0..4 linked to the shared eval user. Slots 5..a each get their own
-- auth user (stays under 5-character-per-user trigger).
-- Usage: psql $LOCAL_API_POSTGRES_URL -f seeds/gamma_explorer.sql

BEGIN;

DELETE FROM events WHERE character_id IN (
  'c0000000-0000-4000-8000-000000000003',
  'c0000000-1000-4000-8000-000000000003',
  'c0000000-2000-4000-8000-000000000003',
  'c0000000-3000-4000-8000-000000000003',
  'c0000000-4000-4000-8000-000000000003',
  'c0000000-5000-4000-8000-000000000003',
  'c0000000-6000-4000-8000-000000000003',
  'c0000000-7000-4000-8000-000000000003',
  'c0000000-8000-4000-8000-000000000003',
  'c0000000-9000-4000-8000-000000000003',
  'c0000000-a000-4000-8000-000000000003'
);
DELETE FROM events WHERE sender_id IN (
  'c0000000-0000-4000-8000-000000000003',
  'c0000000-1000-4000-8000-000000000003',
  'c0000000-2000-4000-8000-000000000003',
  'c0000000-3000-4000-8000-000000000003',
  'c0000000-4000-4000-8000-000000000003',
  'c0000000-5000-4000-8000-000000000003',
  'c0000000-6000-4000-8000-000000000003',
  'c0000000-7000-4000-8000-000000000003',
  'c0000000-8000-4000-8000-000000000003',
  'c0000000-9000-4000-8000-000000000003',
  'c0000000-a000-4000-8000-000000000003'
);
DELETE FROM events WHERE ship_id IN (
  SELECT ship_id FROM ship_instances WHERE owner_character_id IN (
    'c0000000-0000-4000-8000-000000000003',
    'c0000000-1000-4000-8000-000000000003',
    'c0000000-2000-4000-8000-000000000003',
    'c0000000-3000-4000-8000-000000000003',
    'c0000000-4000-4000-8000-000000000003',
    'c0000000-5000-4000-8000-000000000003',
    'c0000000-6000-4000-8000-000000000003',
    'c0000000-7000-4000-8000-000000000003',
    'c0000000-8000-4000-8000-000000000003',
    'c0000000-9000-4000-8000-000000000003',
    'c0000000-a000-4000-8000-000000000003'
  )
);
DELETE FROM user_characters WHERE character_id IN (
  'c0000000-0000-4000-8000-000000000003',
  'c0000000-1000-4000-8000-000000000003',
  'c0000000-2000-4000-8000-000000000003',
  'c0000000-3000-4000-8000-000000000003',
  'c0000000-4000-4000-8000-000000000003',
  'c0000000-5000-4000-8000-000000000003',
  'c0000000-6000-4000-8000-000000000003',
  'c0000000-7000-4000-8000-000000000003',
  'c0000000-8000-4000-8000-000000000003',
  'c0000000-9000-4000-8000-000000000003',
  'c0000000-a000-4000-8000-000000000003'
);
UPDATE characters SET current_ship_id = NULL WHERE character_id IN (
  'c0000000-0000-4000-8000-000000000003',
  'c0000000-1000-4000-8000-000000000003',
  'c0000000-2000-4000-8000-000000000003',
  'c0000000-3000-4000-8000-000000000003',
  'c0000000-4000-4000-8000-000000000003',
  'c0000000-5000-4000-8000-000000000003',
  'c0000000-6000-4000-8000-000000000003',
  'c0000000-7000-4000-8000-000000000003',
  'c0000000-8000-4000-8000-000000000003',
  'c0000000-9000-4000-8000-000000000003',
  'c0000000-a000-4000-8000-000000000003'
);
DELETE FROM ship_instances WHERE owner_character_id IN (
  'c0000000-0000-4000-8000-000000000003',
  'c0000000-1000-4000-8000-000000000003',
  'c0000000-2000-4000-8000-000000000003',
  'c0000000-3000-4000-8000-000000000003',
  'c0000000-4000-4000-8000-000000000003',
  'c0000000-5000-4000-8000-000000000003',
  'c0000000-6000-4000-8000-000000000003',
  'c0000000-7000-4000-8000-000000000003',
  'c0000000-8000-4000-8000-000000000003',
  'c0000000-9000-4000-8000-000000000003',
  'c0000000-a000-4000-8000-000000000003'
);
DELETE FROM characters WHERE character_id IN (
  'c0000000-0000-4000-8000-000000000003',
  'c0000000-1000-4000-8000-000000000003',
  'c0000000-2000-4000-8000-000000000003',
  'c0000000-3000-4000-8000-000000000003',
  'c0000000-4000-4000-8000-000000000003',
  'c0000000-5000-4000-8000-000000000003',
  'c0000000-6000-4000-8000-000000000003',
  'c0000000-7000-4000-8000-000000000003',
  'c0000000-8000-4000-8000-000000000003',
  'c0000000-9000-4000-8000-000000000003',
  'c0000000-a000-4000-8000-000000000003'
);

-- Overflow auth users for slots 5..a
INSERT INTO auth.users (id, email, aud, role, is_sso_user, is_anonymous) VALUES
  ('c0000000-5000-4aaa-8000-000000000003', 'gamma-eval-5@gradientbang.com',  'authenticated', 'authenticated', false, false),
  ('c0000000-6000-4aaa-8000-000000000003', 'gamma-eval-6@gradientbang.com',  'authenticated', 'authenticated', false, false),
  ('c0000000-7000-4aaa-8000-000000000003', 'gamma-eval-7@gradientbang.com',  'authenticated', 'authenticated', false, false),
  ('c0000000-8000-4aaa-8000-000000000003', 'gamma-eval-8@gradientbang.com',  'authenticated', 'authenticated', false, false),
  ('c0000000-9000-4aaa-8000-000000000003', 'gamma-eval-9@gradientbang.com',  'authenticated', 'authenticated', false, false),
  ('c0000000-a000-4aaa-8000-000000000003', 'gamma-eval-10@gradientbang.com', 'authenticated', 'authenticated', false, false)
ON CONFLICT (id) DO NOTHING;

-- Shared map_knowledge (40 sectors) inserted for every variation via VALUES helper.
INSERT INTO characters (character_id, name, credits_in_megabank, map_knowledge)
SELECT v.character_id, v.name, 20000, '{
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
  }'::jsonb
FROM (VALUES
  ('c0000000-0000-4000-8000-000000000003'::uuid, 'Gamma Explorer Eval0'),
  ('c0000000-1000-4000-8000-000000000003'::uuid, 'Gamma Explorer Eval1'),
  ('c0000000-2000-4000-8000-000000000003'::uuid, 'Gamma Explorer Eval2'),
  ('c0000000-3000-4000-8000-000000000003'::uuid, 'Gamma Explorer Eval3'),
  ('c0000000-4000-4000-8000-000000000003'::uuid, 'Gamma Explorer Eval4'),
  ('c0000000-5000-4000-8000-000000000003'::uuid, 'Gamma Explorer Eval5'),
  ('c0000000-6000-4000-8000-000000000003'::uuid, 'Gamma Explorer Eval6'),
  ('c0000000-7000-4000-8000-000000000003'::uuid, 'Gamma Explorer Eval7'),
  ('c0000000-8000-4000-8000-000000000003'::uuid, 'Gamma Explorer Eval8'),
  ('c0000000-9000-4000-8000-000000000003'::uuid, 'Gamma Explorer Eval9'),
  ('c0000000-a000-4000-8000-000000000003'::uuid, 'Gamma Explorer Eval10')
) AS v(character_id, name);

INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES
  ('c0000000-0000-4000-8000-c00000000003', 'c0000000-0000-4000-8000-000000000003', 'character', 'c0000000-0000-4000-8000-000000000003', 'parhelion_seeker', 37, 15000, 600, 180, 400),
  ('c0000000-1000-4000-8000-c00000000003', 'c0000000-1000-4000-8000-000000000003', 'character', 'c0000000-1000-4000-8000-000000000003', 'parhelion_seeker', 37, 15000, 600, 180, 400),
  ('c0000000-2000-4000-8000-c00000000003', 'c0000000-2000-4000-8000-000000000003', 'character', 'c0000000-2000-4000-8000-000000000003', 'parhelion_seeker', 37, 15000, 600, 180, 400),
  ('c0000000-3000-4000-8000-c00000000003', 'c0000000-3000-4000-8000-000000000003', 'character', 'c0000000-3000-4000-8000-000000000003', 'parhelion_seeker', 37, 15000, 600, 180, 400),
  ('c0000000-4000-4000-8000-c00000000003', 'c0000000-4000-4000-8000-000000000003', 'character', 'c0000000-4000-4000-8000-000000000003', 'parhelion_seeker', 37, 15000, 600, 180, 400),
  ('c0000000-5000-4000-8000-c00000000003', 'c0000000-5000-4000-8000-000000000003', 'character', 'c0000000-5000-4000-8000-000000000003', 'parhelion_seeker', 37, 15000, 600, 180, 400),
  ('c0000000-6000-4000-8000-c00000000003', 'c0000000-6000-4000-8000-000000000003', 'character', 'c0000000-6000-4000-8000-000000000003', 'parhelion_seeker', 37, 15000, 600, 180, 400),
  ('c0000000-7000-4000-8000-c00000000003', 'c0000000-7000-4000-8000-000000000003', 'character', 'c0000000-7000-4000-8000-000000000003', 'parhelion_seeker', 37, 15000, 600, 180, 400),
  ('c0000000-8000-4000-8000-c00000000003', 'c0000000-8000-4000-8000-000000000003', 'character', 'c0000000-8000-4000-8000-000000000003', 'parhelion_seeker', 37, 15000, 600, 180, 400),
  ('c0000000-9000-4000-8000-c00000000003', 'c0000000-9000-4000-8000-000000000003', 'character', 'c0000000-9000-4000-8000-000000000003', 'parhelion_seeker', 37, 15000, 600, 180, 400),
  ('c0000000-a000-4000-8000-c00000000003', 'c0000000-a000-4000-8000-000000000003', 'character', 'c0000000-a000-4000-8000-000000000003', 'parhelion_seeker', 37, 15000, 600, 180, 400);

UPDATE characters SET current_ship_id = 'c0000000-0000-4000-8000-c00000000003' WHERE character_id = 'c0000000-0000-4000-8000-000000000003';
UPDATE characters SET current_ship_id = 'c0000000-1000-4000-8000-c00000000003' WHERE character_id = 'c0000000-1000-4000-8000-000000000003';
UPDATE characters SET current_ship_id = 'c0000000-2000-4000-8000-c00000000003' WHERE character_id = 'c0000000-2000-4000-8000-000000000003';
UPDATE characters SET current_ship_id = 'c0000000-3000-4000-8000-c00000000003' WHERE character_id = 'c0000000-3000-4000-8000-000000000003';
UPDATE characters SET current_ship_id = 'c0000000-4000-4000-8000-c00000000003' WHERE character_id = 'c0000000-4000-4000-8000-000000000003';
UPDATE characters SET current_ship_id = 'c0000000-5000-4000-8000-c00000000003' WHERE character_id = 'c0000000-5000-4000-8000-000000000003';
UPDATE characters SET current_ship_id = 'c0000000-6000-4000-8000-c00000000003' WHERE character_id = 'c0000000-6000-4000-8000-000000000003';
UPDATE characters SET current_ship_id = 'c0000000-7000-4000-8000-c00000000003' WHERE character_id = 'c0000000-7000-4000-8000-000000000003';
UPDATE characters SET current_ship_id = 'c0000000-8000-4000-8000-c00000000003' WHERE character_id = 'c0000000-8000-4000-8000-000000000003';
UPDATE characters SET current_ship_id = 'c0000000-9000-4000-8000-c00000000003' WHERE character_id = 'c0000000-9000-4000-8000-000000000003';
UPDATE characters SET current_ship_id = 'c0000000-a000-4000-8000-c00000000003' WHERE character_id = 'c0000000-a000-4000-8000-000000000003';

INSERT INTO user_characters (user_id, character_id) VALUES
  ('c0000000-0000-4aaa-8000-000000000003', 'c0000000-0000-4000-8000-000000000003'),
  ('c0000000-0000-4aaa-8000-000000000003', 'c0000000-1000-4000-8000-000000000003'),
  ('c0000000-0000-4aaa-8000-000000000003', 'c0000000-2000-4000-8000-000000000003'),
  ('c0000000-0000-4aaa-8000-000000000003', 'c0000000-3000-4000-8000-000000000003'),
  ('c0000000-0000-4aaa-8000-000000000003', 'c0000000-4000-4000-8000-000000000003'),
  ('c0000000-5000-4aaa-8000-000000000003', 'c0000000-5000-4000-8000-000000000003'),
  ('c0000000-6000-4aaa-8000-000000000003', 'c0000000-6000-4000-8000-000000000003'),
  ('c0000000-7000-4aaa-8000-000000000003', 'c0000000-7000-4000-8000-000000000003'),
  ('c0000000-8000-4aaa-8000-000000000003', 'c0000000-8000-4000-8000-000000000003'),
  ('c0000000-9000-4aaa-8000-000000000003', 'c0000000-9000-4000-8000-000000000003'),
  ('c0000000-a000-4aaa-8000-000000000003', 'c0000000-a000-4000-8000-000000000003');

-- Seed a prior-session history for event-log queries ("what did I do last session?").
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
  '{"source": "gamma-explorer-eval-seed"}'::jsonb
FROM (VALUES
  ('c0000000-0000-4000-8000-000000000003'::uuid, 37, 'c0000000-0000-4000-8000-c00000000003'::uuid),
  ('c0000000-1000-4000-8000-000000000003'::uuid, 37, 'c0000000-1000-4000-8000-c00000000003'::uuid),
  ('c0000000-2000-4000-8000-000000000003'::uuid, 37, 'c0000000-2000-4000-8000-c00000000003'::uuid),
  ('c0000000-3000-4000-8000-000000000003'::uuid, 37, 'c0000000-3000-4000-8000-c00000000003'::uuid),
  ('c0000000-4000-4000-8000-000000000003'::uuid, 37, 'c0000000-4000-4000-8000-c00000000003'::uuid),
  ('c0000000-5000-4000-8000-000000000003'::uuid, 37, 'c0000000-5000-4000-8000-c00000000003'::uuid),
  ('c0000000-6000-4000-8000-000000000003'::uuid, 37, 'c0000000-6000-4000-8000-c00000000003'::uuid),
  ('c0000000-7000-4000-8000-000000000003'::uuid, 37, 'c0000000-7000-4000-8000-c00000000003'::uuid),
  ('c0000000-8000-4000-8000-000000000003'::uuid, 37, 'c0000000-8000-4000-8000-c00000000003'::uuid),
  ('c0000000-9000-4000-8000-000000000003'::uuid, 37, 'c0000000-9000-4000-8000-c00000000003'::uuid),
  ('c0000000-a000-4000-8000-000000000003'::uuid, 37, 'c0000000-a000-4000-8000-c00000000003'::uuid)
) AS v(character_id, sector_id, ship_id)
CROSS JOIN (VALUES
  ('session.started', INTERVAL '0 minutes', '{"source": "seed", "sector": 37, "ship_name": "Parhelion Seeker", "ship_type": "parhelion_seeker"}'),
  ('task.finish',     INTERVAL '10 minutes', '{"task_summary": "Scouted four new sectors along the northeast corridor and logged their adjacencies.", "task_status": "completed"}')
) AS e(event_type, offset_interval, payload);

-- Seed a prior ship.destroyed event for each variation so 247889 "Why was my
-- ship destroyed?" has data to return. Accompanied by a combat.ended event
-- keyed to the same synthetic combat_id for the step-2 follow-up query.
INSERT INTO events (timestamp, direction, event_type, character_id, sender_id, sector_id, payload, meta)
SELECT
  NOW() - INTERVAL '1 day' + e.offset_interval,
  'event_out',
  e.event_type,
  v.character_id,
  v.character_id,
  v.sector_id,
  e.payload_tmpl::jsonb
    || jsonb_build_object('combat_id', 'combat-gamma-' || substr(v.character_id::text, 1, 8)),
  '{"source": "gamma-explorer-eval-seed"}'::jsonb
FROM (VALUES
  ('c0000000-0000-4000-8000-000000000003'::uuid, 37),
  ('c0000000-1000-4000-8000-000000000003'::uuid, 37),
  ('c0000000-2000-4000-8000-000000000003'::uuid, 37),
  ('c0000000-3000-4000-8000-000000000003'::uuid, 37),
  ('c0000000-4000-4000-8000-000000000003'::uuid, 37),
  ('c0000000-5000-4000-8000-000000000003'::uuid, 37),
  ('c0000000-6000-4000-8000-000000000003'::uuid, 37),
  ('c0000000-7000-4000-8000-000000000003'::uuid, 37),
  ('c0000000-8000-4000-8000-000000000003'::uuid, 37),
  ('c0000000-9000-4000-8000-000000000003'::uuid, 37),
  ('c0000000-a000-4000-8000-000000000003'::uuid, 37)
) AS v(character_id, sector_id)
CROSS JOIN (VALUES
  ('ship.destroyed', INTERVAL '0 minutes',
   '{"ship_name": "Old Parhelion Seeker", "ship_type": "parhelion_seeker", "player_name": "Gamma Explorer Eval", "sector": 37, "salvage_created": true}'),
  ('combat.ended',   INTERVAL '1 minute',
   '{"result": "gamma_defeated", "sector": 37, "participants": [{"id": "gamma-ship", "role": "commander_ship"}, {"id": "drifter-ship", "role": "hostile_npc"}], "flee_results": []}')
) AS e(event_type, offset_interval, payload_tmpl);

-- Give every character knowledge of one mega-port so list_known_ports(mega=true) resolves.
DO $gamma_mega_port$
DECLARE
  v_mega_port INT;
  v_adj JSONB;
  v_pos JSONB;
  v_sector_entry JSONB;
  v_char_ids UUID[] := ARRAY[
    'c0000000-0000-4000-8000-000000000003'::uuid,
    'c0000000-1000-4000-8000-000000000003'::uuid,
    'c0000000-2000-4000-8000-000000000003'::uuid,
    'c0000000-3000-4000-8000-000000000003'::uuid,
    'c0000000-4000-4000-8000-000000000003'::uuid,
    'c0000000-5000-4000-8000-000000000003'::uuid,
    'c0000000-6000-4000-8000-000000000003'::uuid,
    'c0000000-7000-4000-8000-000000000003'::uuid,
    'c0000000-8000-4000-8000-000000000003'::uuid,
    'c0000000-9000-4000-8000-000000000003'::uuid,
    'c0000000-a000-4000-8000-000000000003'::uuid
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
END $gamma_mega_port$;

-- Add scenario-target sectors 1024, 5678 for "move to 1024" (246186) and
-- "distance to 5678" (246187).
DO $gamma_target_sectors$
DECLARE
  v_char_ids UUID[] := ARRAY[
    'c0000000-0000-4000-8000-000000000003'::uuid, 'c0000000-1000-4000-8000-000000000003'::uuid,
    'c0000000-2000-4000-8000-000000000003'::uuid, 'c0000000-3000-4000-8000-000000000003'::uuid,
    'c0000000-4000-4000-8000-000000000003'::uuid, 'c0000000-5000-4000-8000-000000000003'::uuid,
    'c0000000-6000-4000-8000-000000000003'::uuid, 'c0000000-7000-4000-8000-000000000003'::uuid,
    'c0000000-8000-4000-8000-000000000003'::uuid, 'c0000000-9000-4000-8000-000000000003'::uuid,
    'c0000000-a000-4000-8000-000000000003'::uuid
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
  FROM (VALUES (1024), (5678)) AS s(sector_id)
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
END $gamma_target_sectors$;

-- Backdate first_visit and created_at so the join is_first_visit heuristic returns false.
UPDATE characters SET first_visit = NOW() - INTERVAL '1 day', created_at = NOW() - INTERVAL '1 day' WHERE character_id IN (
  'c0000000-0000-4000-8000-000000000003',
  'c0000000-1000-4000-8000-000000000003',
  'c0000000-2000-4000-8000-000000000003',
  'c0000000-3000-4000-8000-000000000003',
  'c0000000-4000-4000-8000-000000000003',
  'c0000000-5000-4000-8000-000000000003',
  'c0000000-6000-4000-8000-000000000003',
  'c0000000-7000-4000-8000-000000000003',
  'c0000000-8000-4000-8000-000000000003',
  'c0000000-9000-4000-8000-000000000003',
  'c0000000-a000-4000-8000-000000000003'
);

COMMIT;
