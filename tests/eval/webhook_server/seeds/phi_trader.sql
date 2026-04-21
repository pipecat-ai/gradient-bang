-- Phi Trader Eval — corp founder with personal kestrel_courier + two corp ships
-- Designed for credit transfer evals: personal-to-corp, corp-to-corp
-- Seeds 8 variations (Eval0..Eval7), each founding its own Phi Trading Co.
-- Slots 0..4 linked to the shared phi eval user. Slots 5..7 each get their own
-- auth user (stays under 5-character-per-user trigger).
-- Usage: psql $LOCAL_API_POSTGRES_URL -f seeds/phi_trader.sql

BEGIN;

DELETE FROM events WHERE character_id IN (
  'f0000000-0000-4000-8000-000000000006',
  'f0000000-1000-4000-8000-000000000006',
  'f0000000-2000-4000-8000-000000000006',
  'f0000000-3000-4000-8000-000000000006',
  'f0000000-4000-4000-8000-000000000006',
  'f0000000-5000-4000-8000-000000000006',
  'f0000000-6000-4000-8000-000000000006',
  'f0000000-7000-4000-8000-000000000006'
);
DELETE FROM events WHERE sender_id IN (
  'f0000000-0000-4000-8000-000000000006',
  'f0000000-1000-4000-8000-000000000006',
  'f0000000-2000-4000-8000-000000000006',
  'f0000000-3000-4000-8000-000000000006',
  'f0000000-4000-4000-8000-000000000006',
  'f0000000-5000-4000-8000-000000000006',
  'f0000000-6000-4000-8000-000000000006',
  'f0000000-7000-4000-8000-000000000006'
);
DELETE FROM events WHERE ship_id IN (
  SELECT ship_id FROM ship_instances WHERE owner_character_id IN (
    'f0000000-0000-4000-8000-000000000006',
    'f0000000-1000-4000-8000-000000000006',
    'f0000000-2000-4000-8000-000000000006',
    'f0000000-3000-4000-8000-000000000006',
    'f0000000-4000-4000-8000-000000000006',
    'f0000000-5000-4000-8000-000000000006',
    'f0000000-6000-4000-8000-000000000006',
    'f0000000-7000-4000-8000-000000000006'
  )
);
DELETE FROM events WHERE ship_id IN (
  SELECT ship_id FROM ship_instances WHERE owner_corporation_id IN (
    'f0000000-0000-4000-8000-c00b00000002',
    'f0000000-1000-4000-8000-c00b00000002',
    'f0000000-2000-4000-8000-c00b00000002',
    'f0000000-3000-4000-8000-c00b00000002',
    'f0000000-4000-4000-8000-c00b00000002',
    'f0000000-5000-4000-8000-c00b00000002',
    'f0000000-6000-4000-8000-c00b00000002',
    'f0000000-7000-4000-8000-c00b00000002'
  )
);
DELETE FROM corporation_ships WHERE corp_id IN (
  'f0000000-0000-4000-8000-c00b00000002',
  'f0000000-1000-4000-8000-c00b00000002',
  'f0000000-2000-4000-8000-c00b00000002',
  'f0000000-3000-4000-8000-c00b00000002',
  'f0000000-4000-4000-8000-c00b00000002',
  'f0000000-5000-4000-8000-c00b00000002',
  'f0000000-6000-4000-8000-c00b00000002',
  'f0000000-7000-4000-8000-c00b00000002'
);
DELETE FROM corporation_members WHERE corp_id IN (
  'f0000000-0000-4000-8000-c00b00000002',
  'f0000000-1000-4000-8000-c00b00000002',
  'f0000000-2000-4000-8000-c00b00000002',
  'f0000000-3000-4000-8000-c00b00000002',
  'f0000000-4000-4000-8000-c00b00000002',
  'f0000000-5000-4000-8000-c00b00000002',
  'f0000000-6000-4000-8000-c00b00000002',
  'f0000000-7000-4000-8000-c00b00000002'
);
DELETE FROM user_characters WHERE character_id IN (
  'f0000000-0000-4000-8000-000000000006',
  'f0000000-1000-4000-8000-000000000006',
  'f0000000-2000-4000-8000-000000000006',
  'f0000000-3000-4000-8000-000000000006',
  'f0000000-4000-4000-8000-000000000006',
  'f0000000-5000-4000-8000-000000000006',
  'f0000000-6000-4000-8000-000000000006',
  'f0000000-7000-4000-8000-000000000006'
);
-- Drop FK references from characters before deleting the ships/corps they point to
UPDATE characters SET current_ship_id = NULL WHERE character_id IN (
  'f0000000-0000-4000-8000-000000000006',
  'f0000000-1000-4000-8000-000000000006',
  'f0000000-2000-4000-8000-000000000006',
  'f0000000-3000-4000-8000-000000000006',
  'f0000000-4000-4000-8000-000000000006',
  'f0000000-5000-4000-8000-000000000006',
  'f0000000-6000-4000-8000-000000000006',
  'f0000000-7000-4000-8000-000000000006'
);
DELETE FROM ship_instances WHERE owner_character_id IN (
  'f0000000-0000-4000-8000-000000000006',
  'f0000000-1000-4000-8000-000000000006',
  'f0000000-2000-4000-8000-000000000006',
  'f0000000-3000-4000-8000-000000000006',
  'f0000000-4000-4000-8000-000000000006',
  'f0000000-5000-4000-8000-000000000006',
  'f0000000-6000-4000-8000-000000000006',
  'f0000000-7000-4000-8000-000000000006'
);
DELETE FROM ship_instances WHERE owner_corporation_id IN (
  'f0000000-0000-4000-8000-c00b00000002',
  'f0000000-1000-4000-8000-c00b00000002',
  'f0000000-2000-4000-8000-c00b00000002',
  'f0000000-3000-4000-8000-c00b00000002',
  'f0000000-4000-4000-8000-c00b00000002',
  'f0000000-5000-4000-8000-c00b00000002',
  'f0000000-6000-4000-8000-c00b00000002',
  'f0000000-7000-4000-8000-c00b00000002'
);
UPDATE characters SET corporation_id = NULL WHERE character_id IN (
  'f0000000-0000-4000-8000-000000000006',
  'f0000000-1000-4000-8000-000000000006',
  'f0000000-2000-4000-8000-000000000006',
  'f0000000-3000-4000-8000-000000000006',
  'f0000000-4000-4000-8000-000000000006',
  'f0000000-5000-4000-8000-000000000006',
  'f0000000-6000-4000-8000-000000000006',
  'f0000000-7000-4000-8000-000000000006'
);
-- Corporations must be deleted BEFORE the characters they reference as founder.
DELETE FROM corporations WHERE corp_id IN (
  'f0000000-0000-4000-8000-c00b00000002',
  'f0000000-1000-4000-8000-c00b00000002',
  'f0000000-2000-4000-8000-c00b00000002',
  'f0000000-3000-4000-8000-c00b00000002',
  'f0000000-4000-4000-8000-c00b00000002',
  'f0000000-5000-4000-8000-c00b00000002',
  'f0000000-6000-4000-8000-c00b00000002',
  'f0000000-7000-4000-8000-c00b00000002'
);
DELETE FROM characters WHERE character_id IN (
  'f0000000-0000-4000-8000-000000000006',
  'f0000000-1000-4000-8000-000000000006',
  'f0000000-2000-4000-8000-000000000006',
  'f0000000-3000-4000-8000-000000000006',
  'f0000000-4000-4000-8000-000000000006',
  'f0000000-5000-4000-8000-000000000006',
  'f0000000-6000-4000-8000-000000000006',
  'f0000000-7000-4000-8000-000000000006'
);

-- Overflow auth users for slots 5..7
INSERT INTO auth.users (id, email, aud, role, is_sso_user, is_anonymous) VALUES
  ('f0000000-5000-4aaa-8000-000000000006', 'phi-eval-5@gradientbang.com', 'authenticated', 'authenticated', false, false),
  ('f0000000-6000-4aaa-8000-000000000006', 'phi-eval-6@gradientbang.com', 'authenticated', 'authenticated', false, false),
  ('f0000000-7000-4aaa-8000-000000000006', 'phi-eval-7@gradientbang.com', 'authenticated', 'authenticated', false, false)
ON CONFLICT (id) DO NOTHING;

-- Characters first (founders must exist before corporations reference them)
INSERT INTO characters (character_id, name, credits_in_megabank, map_knowledge) VALUES
  ('f0000000-0000-4000-8000-000000000006', 'Phi Trader Eval0', 25000, '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'),
  ('f0000000-1000-4000-8000-000000000006', 'Phi Trader Eval1', 25000, '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'),
  ('f0000000-2000-4000-8000-000000000006', 'Phi Trader Eval2', 25000, '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'),
  ('f0000000-3000-4000-8000-000000000006', 'Phi Trader Eval3', 25000, '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'),
  ('f0000000-4000-4000-8000-000000000006', 'Phi Trader Eval4', 25000, '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'),
  ('f0000000-5000-4000-8000-000000000006', 'Phi Trader Eval5', 25000, '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'),
  ('f0000000-6000-4000-8000-000000000006', 'Phi Trader Eval6', 25000, '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'),
  ('f0000000-7000-4000-8000-000000000006', 'Phi Trader Eval7', 25000, '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}');

-- Each Phi founds its own Phi Trading Co
INSERT INTO corporations (corp_id, name, founder_id, invite_code) VALUES
  ('f0000000-0000-4000-8000-c00b00000002', 'Phi Trading Co 0', 'f0000000-0000-4000-8000-000000000006', 'PHITRADE0'),
  ('f0000000-1000-4000-8000-c00b00000002', 'Phi Trading Co 1', 'f0000000-1000-4000-8000-000000000006', 'PHITRADE1'),
  ('f0000000-2000-4000-8000-c00b00000002', 'Phi Trading Co 2', 'f0000000-2000-4000-8000-000000000006', 'PHITRADE2'),
  ('f0000000-3000-4000-8000-c00b00000002', 'Phi Trading Co 3', 'f0000000-3000-4000-8000-000000000006', 'PHITRADE3'),
  ('f0000000-4000-4000-8000-c00b00000002', 'Phi Trading Co 4', 'f0000000-4000-4000-8000-000000000006', 'PHITRADE4'),
  ('f0000000-5000-4000-8000-c00b00000002', 'Phi Trading Co 5', 'f0000000-5000-4000-8000-000000000006', 'PHITRADE5'),
  ('f0000000-6000-4000-8000-c00b00000002', 'Phi Trading Co 6', 'f0000000-6000-4000-8000-000000000006', 'PHITRADE6'),
  ('f0000000-7000-4000-8000-c00b00000002', 'Phi Trading Co 7', 'f0000000-7000-4000-8000-000000000006', 'PHITRADE7');

UPDATE characters SET corporation_id = 'f0000000-0000-4000-8000-c00b00000002' WHERE character_id = 'f0000000-0000-4000-8000-000000000006';
UPDATE characters SET corporation_id = 'f0000000-1000-4000-8000-c00b00000002' WHERE character_id = 'f0000000-1000-4000-8000-000000000006';
UPDATE characters SET corporation_id = 'f0000000-2000-4000-8000-c00b00000002' WHERE character_id = 'f0000000-2000-4000-8000-000000000006';
UPDATE characters SET corporation_id = 'f0000000-3000-4000-8000-c00b00000002' WHERE character_id = 'f0000000-3000-4000-8000-000000000006';
UPDATE characters SET corporation_id = 'f0000000-4000-4000-8000-c00b00000002' WHERE character_id = 'f0000000-4000-4000-8000-000000000006';
UPDATE characters SET corporation_id = 'f0000000-5000-4000-8000-c00b00000002' WHERE character_id = 'f0000000-5000-4000-8000-000000000006';
UPDATE characters SET corporation_id = 'f0000000-6000-4000-8000-c00b00000002' WHERE character_id = 'f0000000-6000-4000-8000-000000000006';
UPDATE characters SET corporation_id = 'f0000000-7000-4000-8000-c00b00000002' WHERE character_id = 'f0000000-7000-4000-8000-000000000006';

INSERT INTO corporation_members (corp_id, character_id) VALUES
  ('f0000000-0000-4000-8000-c00b00000002', 'f0000000-0000-4000-8000-000000000006'),
  ('f0000000-1000-4000-8000-c00b00000002', 'f0000000-1000-4000-8000-000000000006'),
  ('f0000000-2000-4000-8000-c00b00000002', 'f0000000-2000-4000-8000-000000000006'),
  ('f0000000-3000-4000-8000-c00b00000002', 'f0000000-3000-4000-8000-000000000006'),
  ('f0000000-4000-4000-8000-c00b00000002', 'f0000000-4000-4000-8000-000000000006'),
  ('f0000000-5000-4000-8000-c00b00000002', 'f0000000-5000-4000-8000-000000000006'),
  ('f0000000-6000-4000-8000-c00b00000002', 'f0000000-6000-4000-8000-000000000006'),
  ('f0000000-7000-4000-8000-c00b00000002', 'f0000000-7000-4000-8000-000000000006');

-- Personal ships: kestrel_courier in sector 0, 5k credits
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES
  ('f0000000-0000-4000-8000-f00000000001', 'f0000000-0000-4000-8000-000000000006', 'character', 'f0000000-0000-4000-8000-000000000006', 'kestrel_courier', 0, 5000, 500, 150, 300),
  ('f0000000-1000-4000-8000-f00000000001', 'f0000000-1000-4000-8000-000000000006', 'character', 'f0000000-1000-4000-8000-000000000006', 'kestrel_courier', 0, 5000, 500, 150, 300),
  ('f0000000-2000-4000-8000-f00000000001', 'f0000000-2000-4000-8000-000000000006', 'character', 'f0000000-2000-4000-8000-000000000006', 'kestrel_courier', 0, 5000, 500, 150, 300),
  ('f0000000-3000-4000-8000-f00000000001', 'f0000000-3000-4000-8000-000000000006', 'character', 'f0000000-3000-4000-8000-000000000006', 'kestrel_courier', 0, 5000, 500, 150, 300),
  ('f0000000-4000-4000-8000-f00000000001', 'f0000000-4000-4000-8000-000000000006', 'character', 'f0000000-4000-4000-8000-000000000006', 'kestrel_courier', 0, 5000, 500, 150, 300),
  ('f0000000-5000-4000-8000-f00000000001', 'f0000000-5000-4000-8000-000000000006', 'character', 'f0000000-5000-4000-8000-000000000006', 'kestrel_courier', 0, 5000, 500, 150, 300),
  ('f0000000-6000-4000-8000-f00000000001', 'f0000000-6000-4000-8000-000000000006', 'character', 'f0000000-6000-4000-8000-000000000006', 'kestrel_courier', 0, 5000, 500, 150, 300),
  ('f0000000-7000-4000-8000-f00000000001', 'f0000000-7000-4000-8000-000000000006', 'character', 'f0000000-7000-4000-8000-000000000006', 'kestrel_courier', 0, 5000, 500, 150, 300);

-- Corp ship 1: wayfarer_freighter in sector 0, 30k credits
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_corporation_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES
  ('f0000000-0000-4000-8000-f00000000002', 'f0000000-0000-4000-8000-c00b00000002', 'corporation', 'f0000000-0000-4000-8000-c00b00000002', 'wayfarer_freighter', 0, 30000, 800, 300, 600),
  ('f0000000-1000-4000-8000-f00000000002', 'f0000000-1000-4000-8000-c00b00000002', 'corporation', 'f0000000-1000-4000-8000-c00b00000002', 'wayfarer_freighter', 0, 30000, 800, 300, 600),
  ('f0000000-2000-4000-8000-f00000000002', 'f0000000-2000-4000-8000-c00b00000002', 'corporation', 'f0000000-2000-4000-8000-c00b00000002', 'wayfarer_freighter', 0, 30000, 800, 300, 600),
  ('f0000000-3000-4000-8000-f00000000002', 'f0000000-3000-4000-8000-c00b00000002', 'corporation', 'f0000000-3000-4000-8000-c00b00000002', 'wayfarer_freighter', 0, 30000, 800, 300, 600),
  ('f0000000-4000-4000-8000-f00000000002', 'f0000000-4000-4000-8000-c00b00000002', 'corporation', 'f0000000-4000-4000-8000-c00b00000002', 'wayfarer_freighter', 0, 30000, 800, 300, 600),
  ('f0000000-5000-4000-8000-f00000000002', 'f0000000-5000-4000-8000-c00b00000002', 'corporation', 'f0000000-5000-4000-8000-c00b00000002', 'wayfarer_freighter', 0, 30000, 800, 300, 600),
  ('f0000000-6000-4000-8000-f00000000002', 'f0000000-6000-4000-8000-c00b00000002', 'corporation', 'f0000000-6000-4000-8000-c00b00000002', 'wayfarer_freighter', 0, 30000, 800, 300, 600),
  ('f0000000-7000-4000-8000-f00000000002', 'f0000000-7000-4000-8000-c00b00000002', 'corporation', 'f0000000-7000-4000-8000-c00b00000002', 'wayfarer_freighter', 0, 30000, 800, 300, 600);

-- Corp ship 2: autonomous_light_hauler in sector 15, 15k credits
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_corporation_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES
  ('f0000000-0000-4000-8000-f00000000003', 'f0000000-0000-4000-8000-c00b00000002', 'corporation', 'f0000000-0000-4000-8000-c00b00000002', 'autonomous_light_hauler', 15, 15000, 200, 0, 0),
  ('f0000000-1000-4000-8000-f00000000003', 'f0000000-1000-4000-8000-c00b00000002', 'corporation', 'f0000000-1000-4000-8000-c00b00000002', 'autonomous_light_hauler', 15, 15000, 200, 0, 0),
  ('f0000000-2000-4000-8000-f00000000003', 'f0000000-2000-4000-8000-c00b00000002', 'corporation', 'f0000000-2000-4000-8000-c00b00000002', 'autonomous_light_hauler', 15, 15000, 200, 0, 0),
  ('f0000000-3000-4000-8000-f00000000003', 'f0000000-3000-4000-8000-c00b00000002', 'corporation', 'f0000000-3000-4000-8000-c00b00000002', 'autonomous_light_hauler', 15, 15000, 200, 0, 0),
  ('f0000000-4000-4000-8000-f00000000003', 'f0000000-4000-4000-8000-c00b00000002', 'corporation', 'f0000000-4000-4000-8000-c00b00000002', 'autonomous_light_hauler', 15, 15000, 200, 0, 0),
  ('f0000000-5000-4000-8000-f00000000003', 'f0000000-5000-4000-8000-c00b00000002', 'corporation', 'f0000000-5000-4000-8000-c00b00000002', 'autonomous_light_hauler', 15, 15000, 200, 0, 0),
  ('f0000000-6000-4000-8000-f00000000003', 'f0000000-6000-4000-8000-c00b00000002', 'corporation', 'f0000000-6000-4000-8000-c00b00000002', 'autonomous_light_hauler', 15, 15000, 200, 0, 0),
  ('f0000000-7000-4000-8000-f00000000003', 'f0000000-7000-4000-8000-c00b00000002', 'corporation', 'f0000000-7000-4000-8000-c00b00000002', 'autonomous_light_hauler', 15, 15000, 200, 0, 0);

-- Register corp ships
INSERT INTO corporation_ships (corp_id, ship_id, added_by) VALUES
  ('f0000000-0000-4000-8000-c00b00000002', 'f0000000-0000-4000-8000-f00000000002', 'f0000000-0000-4000-8000-000000000006'),
  ('f0000000-0000-4000-8000-c00b00000002', 'f0000000-0000-4000-8000-f00000000003', 'f0000000-0000-4000-8000-000000000006'),
  ('f0000000-1000-4000-8000-c00b00000002', 'f0000000-1000-4000-8000-f00000000002', 'f0000000-1000-4000-8000-000000000006'),
  ('f0000000-1000-4000-8000-c00b00000002', 'f0000000-1000-4000-8000-f00000000003', 'f0000000-1000-4000-8000-000000000006'),
  ('f0000000-2000-4000-8000-c00b00000002', 'f0000000-2000-4000-8000-f00000000002', 'f0000000-2000-4000-8000-000000000006'),
  ('f0000000-2000-4000-8000-c00b00000002', 'f0000000-2000-4000-8000-f00000000003', 'f0000000-2000-4000-8000-000000000006'),
  ('f0000000-3000-4000-8000-c00b00000002', 'f0000000-3000-4000-8000-f00000000002', 'f0000000-3000-4000-8000-000000000006'),
  ('f0000000-3000-4000-8000-c00b00000002', 'f0000000-3000-4000-8000-f00000000003', 'f0000000-3000-4000-8000-000000000006'),
  ('f0000000-4000-4000-8000-c00b00000002', 'f0000000-4000-4000-8000-f00000000002', 'f0000000-4000-4000-8000-000000000006'),
  ('f0000000-4000-4000-8000-c00b00000002', 'f0000000-4000-4000-8000-f00000000003', 'f0000000-4000-4000-8000-000000000006'),
  ('f0000000-5000-4000-8000-c00b00000002', 'f0000000-5000-4000-8000-f00000000002', 'f0000000-5000-4000-8000-000000000006'),
  ('f0000000-5000-4000-8000-c00b00000002', 'f0000000-5000-4000-8000-f00000000003', 'f0000000-5000-4000-8000-000000000006'),
  ('f0000000-6000-4000-8000-c00b00000002', 'f0000000-6000-4000-8000-f00000000002', 'f0000000-6000-4000-8000-000000000006'),
  ('f0000000-6000-4000-8000-c00b00000002', 'f0000000-6000-4000-8000-f00000000003', 'f0000000-6000-4000-8000-000000000006'),
  ('f0000000-7000-4000-8000-c00b00000002', 'f0000000-7000-4000-8000-f00000000002', 'f0000000-7000-4000-8000-000000000006'),
  ('f0000000-7000-4000-8000-c00b00000002', 'f0000000-7000-4000-8000-f00000000003', 'f0000000-7000-4000-8000-000000000006');

-- Set active personal ship
UPDATE characters SET current_ship_id = 'f0000000-0000-4000-8000-f00000000001' WHERE character_id = 'f0000000-0000-4000-8000-000000000006';
UPDATE characters SET current_ship_id = 'f0000000-1000-4000-8000-f00000000001' WHERE character_id = 'f0000000-1000-4000-8000-000000000006';
UPDATE characters SET current_ship_id = 'f0000000-2000-4000-8000-f00000000001' WHERE character_id = 'f0000000-2000-4000-8000-000000000006';
UPDATE characters SET current_ship_id = 'f0000000-3000-4000-8000-f00000000001' WHERE character_id = 'f0000000-3000-4000-8000-000000000006';
UPDATE characters SET current_ship_id = 'f0000000-4000-4000-8000-f00000000001' WHERE character_id = 'f0000000-4000-4000-8000-000000000006';
UPDATE characters SET current_ship_id = 'f0000000-5000-4000-8000-f00000000001' WHERE character_id = 'f0000000-5000-4000-8000-000000000006';
UPDATE characters SET current_ship_id = 'f0000000-6000-4000-8000-f00000000001' WHERE character_id = 'f0000000-6000-4000-8000-000000000006';
UPDATE characters SET current_ship_id = 'f0000000-7000-4000-8000-f00000000001' WHERE character_id = 'f0000000-7000-4000-8000-000000000006';

INSERT INTO user_characters (user_id, character_id) VALUES
  ('cf73d883-41fd-4fc5-ba5d-b82241d26ca7',   'f0000000-0000-4000-8000-000000000006'),
  ('cf73d883-41fd-4fc5-ba5d-b82241d26ca7',   'f0000000-1000-4000-8000-000000000006'),
  ('cf73d883-41fd-4fc5-ba5d-b82241d26ca7',   'f0000000-2000-4000-8000-000000000006'),
  ('cf73d883-41fd-4fc5-ba5d-b82241d26ca7',   'f0000000-3000-4000-8000-000000000006'),
  ('cf73d883-41fd-4fc5-ba5d-b82241d26ca7',   'f0000000-4000-4000-8000-000000000006'),
  ('f0000000-5000-4aaa-8000-000000000006',   'f0000000-5000-4000-8000-000000000006'),
  ('f0000000-6000-4aaa-8000-000000000006',   'f0000000-6000-4000-8000-000000000006'),
  ('f0000000-7000-4aaa-8000-000000000006',   'f0000000-7000-4000-8000-000000000006');

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
  '{"source": "phi-trader-eval-seed"}'::jsonb
FROM (VALUES
  ('f0000000-0000-4000-8000-000000000006'::uuid, 0, 'f0000000-0000-4000-8000-f00000000001'::uuid),
  ('f0000000-1000-4000-8000-000000000006'::uuid, 0, 'f0000000-1000-4000-8000-f00000000001'::uuid),
  ('f0000000-2000-4000-8000-000000000006'::uuid, 0, 'f0000000-2000-4000-8000-f00000000001'::uuid),
  ('f0000000-3000-4000-8000-000000000006'::uuid, 0, 'f0000000-3000-4000-8000-f00000000001'::uuid),
  ('f0000000-4000-4000-8000-000000000006'::uuid, 0, 'f0000000-4000-4000-8000-f00000000001'::uuid),
  ('f0000000-5000-4000-8000-000000000006'::uuid, 0, 'f0000000-5000-4000-8000-f00000000001'::uuid),
  ('f0000000-6000-4000-8000-000000000006'::uuid, 0, 'f0000000-6000-4000-8000-f00000000001'::uuid),
  ('f0000000-7000-4000-8000-000000000006'::uuid, 0, 'f0000000-7000-4000-8000-f00000000001'::uuid)
) AS v(character_id, sector_id, ship_id)
CROSS JOIN (VALUES
  ('session.started', INTERVAL '0 minutes', '{"source": "seed", "sector": 0, "ship_name": "Kestrel Courier", "ship_type": "kestrel_courier"}'),
  ('task.finish',     INTERVAL '10 minutes', '{"task_summary": "Transferred 1000 credits from the Wayfarer Freighter to the personal ship.", "task_status": "completed"}')
) AS e(event_type, offset_interval, payload);

-- Give every character knowledge of one mega-port so list_known_ports(mega=true) resolves.
DO $phi_mega_port$
DECLARE
  v_mega_port INT;
  v_adj JSONB;
  v_pos JSONB;
  v_sector_entry JSONB;
  v_char_ids UUID[] := ARRAY[
    'f0000000-0000-4000-8000-000000000006'::uuid,
    'f0000000-1000-4000-8000-000000000006'::uuid,
    'f0000000-2000-4000-8000-000000000006'::uuid,
    'f0000000-3000-4000-8000-000000000006'::uuid,
    'f0000000-4000-4000-8000-000000000006'::uuid,
    'f0000000-5000-4000-8000-000000000006'::uuid,
    'f0000000-6000-4000-8000-000000000006'::uuid,
    'f0000000-7000-4000-8000-000000000006'::uuid
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
END $phi_mega_port$;

-- Move Phi's personal kestrel + corp wayfarer to a mega-port sector so
-- bank_deposit (246202) and warp recharge (247898) scenarios can run.
-- Light Hauler stays at sector 15 so 246200 (corp→corp transfer) exercises
-- the "different sectors, must move first" flow.
DO $phi_move_to_megaport$
DECLARE
  v_mega_port INT;
BEGIN
  SELECT (meta->'mega_port_sectors'->>0)::int INTO v_mega_port
    FROM universe_config WHERE id = 1;
  IF v_mega_port IS NULL THEN RETURN; END IF;
  UPDATE ship_instances
  SET current_sector = v_mega_port
  WHERE ship_id IN (
    'f0000000-0000-4000-8000-f00000000001', 'f0000000-1000-4000-8000-f00000000001',
    'f0000000-2000-4000-8000-f00000000001', 'f0000000-3000-4000-8000-f00000000001',
    'f0000000-4000-4000-8000-f00000000001', 'f0000000-5000-4000-8000-f00000000001',
    'f0000000-6000-4000-8000-f00000000001', 'f0000000-7000-4000-8000-f00000000001',
    'f0000000-0000-4000-8000-f00000000002', 'f0000000-1000-4000-8000-f00000000002',
    'f0000000-2000-4000-8000-f00000000002', 'f0000000-3000-4000-8000-f00000000002',
    'f0000000-4000-4000-8000-f00000000002', 'f0000000-5000-4000-8000-f00000000002',
    'f0000000-6000-4000-8000-f00000000002', 'f0000000-7000-4000-8000-f00000000002'
  );
END $phi_move_to_megaport$;

-- Backdate first_visit and created_at so the join is_first_visit heuristic returns false.
UPDATE characters SET first_visit = NOW() - INTERVAL '1 day', created_at = NOW() - INTERVAL '1 day' WHERE character_id IN (
  'f0000000-0000-4000-8000-000000000006',
  'f0000000-1000-4000-8000-000000000006',
  'f0000000-2000-4000-8000-000000000006',
  'f0000000-3000-4000-8000-000000000006',
  'f0000000-4000-4000-8000-000000000006',
  'f0000000-5000-4000-8000-000000000006',
  'f0000000-6000-4000-8000-000000000006',
  'f0000000-7000-4000-8000-000000000006'
);

COMMIT;
