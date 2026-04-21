-- Delta Fleet Eval — multiple ships, active in a wayfarer_freighter at sector 42
-- so combat scenarios (246193/247893/247894) can initiate (sector 0 may be
-- Federation Space). Each variation gets a hostile NPC ("Delta Drifter") in the
-- same sector for combat targets.
-- Seeds 7 variations (Eval0..Eval6). Slots 0..4 linked to the Delta base auth
-- user; slots 5..6 each get their own auth user.
-- Usage: psql $LOCAL_API_POSTGRES_URL -f seeds/delta_fleet.sql

BEGIN;

-- ── TEARDOWN ──────────────────────────────────────────────────────────
-- NPC hostiles first (they hold ship refs we need to nuke before delta ships).
DELETE FROM events WHERE character_id IN (
  'dd000000-0000-4000-8000-000000000004', 'dd000000-1000-4000-8000-000000000004',
  'dd000000-2000-4000-8000-000000000004', 'dd000000-3000-4000-8000-000000000004',
  'dd000000-4000-4000-8000-000000000004', 'dd000000-5000-4000-8000-000000000004',
  'dd000000-6000-4000-8000-000000000004'
);
DELETE FROM events WHERE sender_id IN (
  'dd000000-0000-4000-8000-000000000004', 'dd000000-1000-4000-8000-000000000004',
  'dd000000-2000-4000-8000-000000000004', 'dd000000-3000-4000-8000-000000000004',
  'dd000000-4000-4000-8000-000000000004', 'dd000000-5000-4000-8000-000000000004',
  'dd000000-6000-4000-8000-000000000004'
);
UPDATE characters SET current_ship_id = NULL WHERE character_id IN (
  'dd000000-0000-4000-8000-000000000004', 'dd000000-1000-4000-8000-000000000004',
  'dd000000-2000-4000-8000-000000000004', 'dd000000-3000-4000-8000-000000000004',
  'dd000000-4000-4000-8000-000000000004', 'dd000000-5000-4000-8000-000000000004',
  'dd000000-6000-4000-8000-000000000004'
);
DELETE FROM ship_instances WHERE owner_character_id IN (
  'dd000000-0000-4000-8000-000000000004', 'dd000000-1000-4000-8000-000000000004',
  'dd000000-2000-4000-8000-000000000004', 'dd000000-3000-4000-8000-000000000004',
  'dd000000-4000-4000-8000-000000000004', 'dd000000-5000-4000-8000-000000000004',
  'dd000000-6000-4000-8000-000000000004'
);
DELETE FROM characters WHERE character_id IN (
  'dd000000-0000-4000-8000-000000000004', 'dd000000-1000-4000-8000-000000000004',
  'dd000000-2000-4000-8000-000000000004', 'dd000000-3000-4000-8000-000000000004',
  'dd000000-4000-4000-8000-000000000004', 'dd000000-5000-4000-8000-000000000004',
  'dd000000-6000-4000-8000-000000000004'
);

DELETE FROM events WHERE character_id IN (
  'd0000000-0000-4000-8000-000000000004',
  'd0000000-1000-4000-8000-000000000004',
  'd0000000-2000-4000-8000-000000000004',
  'd0000000-3000-4000-8000-000000000004',
  'd0000000-4000-4000-8000-000000000004',
  'd0000000-5000-4000-8000-000000000004',
  'd0000000-6000-4000-8000-000000000004'
);
DELETE FROM events WHERE sender_id IN (
  'd0000000-0000-4000-8000-000000000004',
  'd0000000-1000-4000-8000-000000000004',
  'd0000000-2000-4000-8000-000000000004',
  'd0000000-3000-4000-8000-000000000004',
  'd0000000-4000-4000-8000-000000000004',
  'd0000000-5000-4000-8000-000000000004',
  'd0000000-6000-4000-8000-000000000004'
);
DELETE FROM events WHERE ship_id IN (
  SELECT ship_id FROM ship_instances WHERE owner_character_id IN (
    'd0000000-0000-4000-8000-000000000004',
    'd0000000-1000-4000-8000-000000000004',
    'd0000000-2000-4000-8000-000000000004',
    'd0000000-3000-4000-8000-000000000004',
    'd0000000-4000-4000-8000-000000000004',
    'd0000000-5000-4000-8000-000000000004',
    'd0000000-6000-4000-8000-000000000004'
  )
);
DELETE FROM user_characters WHERE character_id IN (
  'd0000000-0000-4000-8000-000000000004',
  'd0000000-1000-4000-8000-000000000004',
  'd0000000-2000-4000-8000-000000000004',
  'd0000000-3000-4000-8000-000000000004',
  'd0000000-4000-4000-8000-000000000004',
  'd0000000-5000-4000-8000-000000000004',
  'd0000000-6000-4000-8000-000000000004'
);
UPDATE characters SET current_ship_id = NULL WHERE character_id IN (
  'd0000000-0000-4000-8000-000000000004',
  'd0000000-1000-4000-8000-000000000004',
  'd0000000-2000-4000-8000-000000000004',
  'd0000000-3000-4000-8000-000000000004',
  'd0000000-4000-4000-8000-000000000004',
  'd0000000-5000-4000-8000-000000000004',
  'd0000000-6000-4000-8000-000000000004'
);
DELETE FROM ship_instances WHERE owner_character_id IN (
  'd0000000-0000-4000-8000-000000000004',
  'd0000000-1000-4000-8000-000000000004',
  'd0000000-2000-4000-8000-000000000004',
  'd0000000-3000-4000-8000-000000000004',
  'd0000000-4000-4000-8000-000000000004',
  'd0000000-5000-4000-8000-000000000004',
  'd0000000-6000-4000-8000-000000000004'
);
DELETE FROM characters WHERE character_id IN (
  'd0000000-0000-4000-8000-000000000004',
  'd0000000-1000-4000-8000-000000000004',
  'd0000000-2000-4000-8000-000000000004',
  'd0000000-3000-4000-8000-000000000004',
  'd0000000-4000-4000-8000-000000000004',
  'd0000000-5000-4000-8000-000000000004',
  'd0000000-6000-4000-8000-000000000004'
);

-- ── SEED ──────────────────────────────────────────────────────────────
-- Overflow auth users for slots 5..6
INSERT INTO auth.users (id, email, aud, role, is_sso_user, is_anonymous) VALUES
  ('d0000000-5000-4aaa-8000-000000000004', 'delta-eval-5@gradientbang.com', 'authenticated', 'authenticated', false, false),
  ('d0000000-6000-4aaa-8000-000000000004', 'delta-eval-6@gradientbang.com', 'authenticated', 'authenticated', false, false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO characters (character_id, name, credits_in_megabank, map_knowledge) VALUES
  ('d0000000-0000-4000-8000-000000000004', 'Delta Fleet Eval0', 50000, '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'),
  ('d0000000-1000-4000-8000-000000000004', 'Delta Fleet Eval1', 50000, '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'),
  ('d0000000-2000-4000-8000-000000000004', 'Delta Fleet Eval2', 50000, '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'),
  ('d0000000-3000-4000-8000-000000000004', 'Delta Fleet Eval3', 50000, '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'),
  ('d0000000-4000-4000-8000-000000000004', 'Delta Fleet Eval4', 50000, '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'),
  ('d0000000-5000-4000-8000-000000000004', 'Delta Fleet Eval5', 50000, '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'),
  ('d0000000-6000-4000-8000-000000000004', 'Delta Fleet Eval6', 50000, '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}');

-- Wayfarer freighters (active ship) — at sector 42 for combat scenarios
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES
  ('d0000000-0000-4000-8000-d00000000001', 'd0000000-0000-4000-8000-000000000004', 'character', 'd0000000-0000-4000-8000-000000000004', 'wayfarer_freighter', 42, 30000, 800, 300, 600),
  ('d0000000-1000-4000-8000-d00000000001', 'd0000000-1000-4000-8000-000000000004', 'character', 'd0000000-1000-4000-8000-000000000004', 'wayfarer_freighter', 42, 30000, 800, 300, 600),
  ('d0000000-2000-4000-8000-d00000000001', 'd0000000-2000-4000-8000-000000000004', 'character', 'd0000000-2000-4000-8000-000000000004', 'wayfarer_freighter', 42, 30000, 800, 300, 600),
  ('d0000000-3000-4000-8000-d00000000001', 'd0000000-3000-4000-8000-000000000004', 'character', 'd0000000-3000-4000-8000-000000000004', 'wayfarer_freighter', 42, 30000, 800, 300, 600),
  ('d0000000-4000-4000-8000-d00000000001', 'd0000000-4000-4000-8000-000000000004', 'character', 'd0000000-4000-4000-8000-000000000004', 'wayfarer_freighter', 42, 30000, 800, 300, 600),
  ('d0000000-5000-4000-8000-d00000000001', 'd0000000-5000-4000-8000-000000000004', 'character', 'd0000000-5000-4000-8000-000000000004', 'wayfarer_freighter', 42, 30000, 800, 300, 600),
  ('d0000000-6000-4000-8000-d00000000001', 'd0000000-6000-4000-8000-000000000004', 'character', 'd0000000-6000-4000-8000-000000000004', 'wayfarer_freighter', 42, 30000, 800, 300, 600);

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
  ('d0000000-4000-4000-8000-d00000000002', 'd0000000-4000-4000-8000-000000000004', 'character', 'd0000000-4000-4000-8000-000000000004', 'corsair_raider', 42, 5000, 700, 400, 1500),
  ('d0000000-5000-4000-8000-d00000000002', 'd0000000-5000-4000-8000-000000000004', 'character', 'd0000000-5000-4000-8000-000000000004', 'corsair_raider', 42, 5000, 700, 400, 1500),
  ('d0000000-6000-4000-8000-d00000000002', 'd0000000-6000-4000-8000-000000000004', 'character', 'd0000000-6000-4000-8000-000000000004', 'corsair_raider', 42, 5000, 700, 400, 1500);

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
  ('d0000000-4000-4000-8000-d00000000003', 'd0000000-4000-4000-8000-000000000004', 'character', 'd0000000-4000-4000-8000-000000000004', 'kestrel_courier', 15, 0, 500, 150, 300),
  ('d0000000-5000-4000-8000-d00000000003', 'd0000000-5000-4000-8000-000000000004', 'character', 'd0000000-5000-4000-8000-000000000004', 'kestrel_courier', 15, 0, 500, 150, 300),
  ('d0000000-6000-4000-8000-d00000000003', 'd0000000-6000-4000-8000-000000000004', 'character', 'd0000000-6000-4000-8000-000000000004', 'kestrel_courier', 15, 0, 500, 150, 300);

-- Hostile NPC characters (one per Delta variation, at sector 42)
INSERT INTO characters (character_id, name, credits_in_megabank, is_npc, map_knowledge, player_metadata) VALUES
  ('dd000000-0000-4000-8000-000000000004', 'Delta Drifter 0', 0, TRUE, '{"total_sectors_visited": 1, "sectors_visited": {"42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'::jsonb, '{"source": "delta-fleet-eval-seed", "role": "hostile-npc"}'::jsonb),
  ('dd000000-1000-4000-8000-000000000004', 'Delta Drifter 1', 0, TRUE, '{"total_sectors_visited": 1, "sectors_visited": {"42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'::jsonb, '{"source": "delta-fleet-eval-seed", "role": "hostile-npc"}'::jsonb),
  ('dd000000-2000-4000-8000-000000000004', 'Delta Drifter 2', 0, TRUE, '{"total_sectors_visited": 1, "sectors_visited": {"42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'::jsonb, '{"source": "delta-fleet-eval-seed", "role": "hostile-npc"}'::jsonb),
  ('dd000000-3000-4000-8000-000000000004', 'Delta Drifter 3', 0, TRUE, '{"total_sectors_visited": 1, "sectors_visited": {"42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'::jsonb, '{"source": "delta-fleet-eval-seed", "role": "hostile-npc"}'::jsonb),
  ('dd000000-4000-4000-8000-000000000004', 'Delta Drifter 4', 0, TRUE, '{"total_sectors_visited": 1, "sectors_visited": {"42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'::jsonb, '{"source": "delta-fleet-eval-seed", "role": "hostile-npc"}'::jsonb),
  ('dd000000-5000-4000-8000-000000000004', 'Delta Drifter 5', 0, TRUE, '{"total_sectors_visited": 1, "sectors_visited": {"42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'::jsonb, '{"source": "delta-fleet-eval-seed", "role": "hostile-npc"}'::jsonb),
  ('dd000000-6000-4000-8000-000000000004', 'Delta Drifter 6', 0, TRUE, '{"total_sectors_visited": 1, "sectors_visited": {"42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'::jsonb, '{"source": "delta-fleet-eval-seed", "role": "hostile-npc"}'::jsonb);

-- Hostile NPC ships (armed corsair_raider "Rust Fang", sector 42)
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, ship_name, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES
  ('dd000000-0000-4000-8000-dd00000000ff', 'dd000000-0000-4000-8000-000000000004', 'character', 'dd000000-0000-4000-8000-000000000004', 'corsair_raider', 'Rust Fang', 42, 500, 700, 400, 60),
  ('dd000000-1000-4000-8000-dd00000000ff', 'dd000000-1000-4000-8000-000000000004', 'character', 'dd000000-1000-4000-8000-000000000004', 'corsair_raider', 'Rust Fang', 42, 500, 700, 400, 60),
  ('dd000000-2000-4000-8000-dd00000000ff', 'dd000000-2000-4000-8000-000000000004', 'character', 'dd000000-2000-4000-8000-000000000004', 'corsair_raider', 'Rust Fang', 42, 500, 700, 400, 60),
  ('dd000000-3000-4000-8000-dd00000000ff', 'dd000000-3000-4000-8000-000000000004', 'character', 'dd000000-3000-4000-8000-000000000004', 'corsair_raider', 'Rust Fang', 42, 500, 700, 400, 60),
  ('dd000000-4000-4000-8000-dd00000000ff', 'dd000000-4000-4000-8000-000000000004', 'character', 'dd000000-4000-4000-8000-000000000004', 'corsair_raider', 'Rust Fang', 42, 500, 700, 400, 60),
  ('dd000000-5000-4000-8000-dd00000000ff', 'dd000000-5000-4000-8000-000000000004', 'character', 'dd000000-5000-4000-8000-000000000004', 'corsair_raider', 'Rust Fang', 42, 500, 700, 400, 60),
  ('dd000000-6000-4000-8000-dd00000000ff', 'dd000000-6000-4000-8000-000000000004', 'character', 'dd000000-6000-4000-8000-000000000004', 'corsair_raider', 'Rust Fang', 42, 500, 700, 400, 60);

UPDATE characters SET current_ship_id = 'd0000000-0000-4000-8000-d00000000001' WHERE character_id = 'd0000000-0000-4000-8000-000000000004';
UPDATE characters SET current_ship_id = 'd0000000-1000-4000-8000-d00000000001' WHERE character_id = 'd0000000-1000-4000-8000-000000000004';
UPDATE characters SET current_ship_id = 'd0000000-2000-4000-8000-d00000000001' WHERE character_id = 'd0000000-2000-4000-8000-000000000004';
UPDATE characters SET current_ship_id = 'd0000000-3000-4000-8000-d00000000001' WHERE character_id = 'd0000000-3000-4000-8000-000000000004';
UPDATE characters SET current_ship_id = 'd0000000-4000-4000-8000-d00000000001' WHERE character_id = 'd0000000-4000-4000-8000-000000000004';
UPDATE characters SET current_ship_id = 'd0000000-5000-4000-8000-d00000000001' WHERE character_id = 'd0000000-5000-4000-8000-000000000004';
UPDATE characters SET current_ship_id = 'd0000000-6000-4000-8000-d00000000001' WHERE character_id = 'd0000000-6000-4000-8000-000000000004';

-- Active ships for NPCs
UPDATE characters SET current_ship_id = 'dd000000-0000-4000-8000-dd00000000ff' WHERE character_id = 'dd000000-0000-4000-8000-000000000004';
UPDATE characters SET current_ship_id = 'dd000000-1000-4000-8000-dd00000000ff' WHERE character_id = 'dd000000-1000-4000-8000-000000000004';
UPDATE characters SET current_ship_id = 'dd000000-2000-4000-8000-dd00000000ff' WHERE character_id = 'dd000000-2000-4000-8000-000000000004';
UPDATE characters SET current_ship_id = 'dd000000-3000-4000-8000-dd00000000ff' WHERE character_id = 'dd000000-3000-4000-8000-000000000004';
UPDATE characters SET current_ship_id = 'dd000000-4000-4000-8000-dd00000000ff' WHERE character_id = 'dd000000-4000-4000-8000-000000000004';
UPDATE characters SET current_ship_id = 'dd000000-5000-4000-8000-dd00000000ff' WHERE character_id = 'dd000000-5000-4000-8000-000000000004';
UPDATE characters SET current_ship_id = 'dd000000-6000-4000-8000-dd00000000ff' WHERE character_id = 'dd000000-6000-4000-8000-000000000004';

INSERT INTO user_characters (user_id, character_id) VALUES
  ('d0000000-0000-4aaa-8000-000000000004', 'd0000000-0000-4000-8000-000000000004'),
  ('d0000000-0000-4aaa-8000-000000000004', 'd0000000-1000-4000-8000-000000000004'),
  ('d0000000-0000-4aaa-8000-000000000004', 'd0000000-2000-4000-8000-000000000004'),
  ('d0000000-0000-4aaa-8000-000000000004', 'd0000000-3000-4000-8000-000000000004'),
  ('d0000000-0000-4aaa-8000-000000000004', 'd0000000-4000-4000-8000-000000000004'),
  ('d0000000-5000-4aaa-8000-000000000004', 'd0000000-5000-4000-8000-000000000004'),
  ('d0000000-6000-4aaa-8000-000000000004', 'd0000000-6000-4000-8000-000000000004');

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
  '{"source": "delta-fleet-eval-seed"}'::jsonb
FROM (VALUES
  ('d0000000-0000-4000-8000-000000000004'::uuid, 42, 'd0000000-0000-4000-8000-d00000000001'::uuid),
  ('d0000000-1000-4000-8000-000000000004'::uuid, 42, 'd0000000-1000-4000-8000-d00000000001'::uuid),
  ('d0000000-2000-4000-8000-000000000004'::uuid, 42, 'd0000000-2000-4000-8000-d00000000001'::uuid),
  ('d0000000-3000-4000-8000-000000000004'::uuid, 42, 'd0000000-3000-4000-8000-d00000000001'::uuid),
  ('d0000000-4000-4000-8000-000000000004'::uuid, 42, 'd0000000-4000-4000-8000-d00000000001'::uuid),
  ('d0000000-5000-4000-8000-000000000004'::uuid, 42, 'd0000000-5000-4000-8000-d00000000001'::uuid),
  ('d0000000-6000-4000-8000-000000000004'::uuid, 42, 'd0000000-6000-4000-8000-d00000000001'::uuid)
) AS v(character_id, sector_id, ship_id)
CROSS JOIN (VALUES
  ('session.started', INTERVAL '0 minutes', '{"source": "seed", "sector": 42, "ship_name": "Wayfarer Freighter", "ship_type": "wayfarer_freighter"}'),
  ('task.finish',     INTERVAL '10 minutes', '{"task_summary": "Moved the Wayfarer Freighter from sector 0 out to sector 42 and restocked fighters.", "task_status": "completed"}')
) AS e(event_type, offset_interval, payload);

-- Give every character knowledge of one mega-port so list_known_ports(mega=true) resolves.
DO $delta_mega_port$
DECLARE
  v_mega_port INT;
  v_adj JSONB;
  v_pos JSONB;
  v_sector_entry JSONB;
  v_char_ids UUID[] := ARRAY[
    'd0000000-0000-4000-8000-000000000004'::uuid,
    'd0000000-1000-4000-8000-000000000004'::uuid,
    'd0000000-2000-4000-8000-000000000004'::uuid,
    'd0000000-3000-4000-8000-000000000004'::uuid,
    'd0000000-4000-4000-8000-000000000004'::uuid,
    'd0000000-5000-4000-8000-000000000004'::uuid,
    'd0000000-6000-4000-8000-000000000004'::uuid
  ];
BEGIN
  SELECT (meta->'mega_port_sectors'->>0)::int INTO v_mega_port
    FROM universe_config WHERE id = 1;
  IF v_mega_port IS NULL THEN RETURN; END IF;
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
END $delta_mega_port$;

-- Add scenario-target sectors 123, 456 for 246190 "Move my ship to sector 123 / send ship to sector 456".
DO $delta_target_sectors$
DECLARE
  v_char_ids UUID[] := ARRAY[
    'd0000000-0000-4000-8000-000000000004'::uuid, 'd0000000-1000-4000-8000-000000000004'::uuid,
    'd0000000-2000-4000-8000-000000000004'::uuid, 'd0000000-3000-4000-8000-000000000004'::uuid,
    'd0000000-4000-4000-8000-000000000004'::uuid, 'd0000000-5000-4000-8000-000000000004'::uuid,
    'd0000000-6000-4000-8000-000000000004'::uuid
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
  FROM (VALUES (123), (456)) AS s(sector_id)
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
END $delta_target_sectors$;

-- Backdate first_visit and created_at so the join is_first_visit heuristic returns false.
UPDATE characters SET first_visit = NOW() - INTERVAL '1 day', created_at = NOW() - INTERVAL '1 day' WHERE character_id IN (
  'd0000000-0000-4000-8000-000000000004',
  'd0000000-1000-4000-8000-000000000004',
  'd0000000-2000-4000-8000-000000000004',
  'd0000000-3000-4000-8000-000000000004',
  'd0000000-4000-4000-8000-000000000004',
  'd0000000-5000-4000-8000-000000000004',
  'd0000000-6000-4000-8000-000000000004'
);

COMMIT;
