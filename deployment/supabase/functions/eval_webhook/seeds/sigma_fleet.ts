// Generated from tests/eval/webhook_server/seeds/sigma_fleet.sql
// Do not edit directly — run: bash scripts/sync-eval-seeds.sh
export const sql = `
-- Sigma Fleet Eval — corp founder with personal kestrel_courier + three corp ships
-- Designed for deferred-update queue / task-completion narration evals.
-- Three corp ships (Kestrel-1, Kestrel-2, Audit Spectre) so scenarios can
-- batch arrivals across multiple ships and verify settle-window behavior.
-- Seeds 5 variations (Eval0..Eval4), each founding its own Sigma Fleet corp.
-- All 5 slots are linked to the shared sigma eval user (stays at the 5-character cap).
-- Usage: psql $LOCAL_API_POSTGRES_URL -f seeds/sigma_fleet.sql

BEGIN;

-- ── TEARDOWN ──────────────────────────────────────────────────────────
DELETE FROM events WHERE character_id IN (
  '50000000-0000-4000-8000-000000000007',
  '50000000-1000-4000-8000-000000000007',
  '50000000-2000-4000-8000-000000000007',
  '50000000-3000-4000-8000-000000000007',
  '50000000-4000-4000-8000-000000000007'
);
DELETE FROM events WHERE sender_id IN (
  '50000000-0000-4000-8000-000000000007',
  '50000000-1000-4000-8000-000000000007',
  '50000000-2000-4000-8000-000000000007',
  '50000000-3000-4000-8000-000000000007',
  '50000000-4000-4000-8000-000000000007'
);
DELETE FROM events WHERE ship_id IN (
  SELECT ship_id FROM ship_instances WHERE owner_character_id IN (
    '50000000-0000-4000-8000-000000000007',
    '50000000-1000-4000-8000-000000000007',
    '50000000-2000-4000-8000-000000000007',
    '50000000-3000-4000-8000-000000000007',
    '50000000-4000-4000-8000-000000000007'
  )
);
DELETE FROM events WHERE ship_id IN (
  SELECT ship_id FROM ship_instances WHERE owner_corporation_id IN (
    '50000000-0000-4000-8000-c00b00000007',
    '50000000-1000-4000-8000-c00b00000007',
    '50000000-2000-4000-8000-c00b00000007',
    '50000000-3000-4000-8000-c00b00000007',
    '50000000-4000-4000-8000-c00b00000007'
  )
);

DELETE FROM user_characters WHERE character_id IN (
  '50000000-0000-4000-8000-000000000007',
  '50000000-1000-4000-8000-000000000007',
  '50000000-2000-4000-8000-000000000007',
  '50000000-3000-4000-8000-000000000007',
  '50000000-4000-4000-8000-000000000007'
);

UPDATE characters SET current_ship_id = NULL WHERE character_id IN (
  '50000000-0000-4000-8000-000000000007',
  '50000000-1000-4000-8000-000000000007',
  '50000000-2000-4000-8000-000000000007',
  '50000000-3000-4000-8000-000000000007',
  '50000000-4000-4000-8000-000000000007'
);

DELETE FROM corporation_ships WHERE corp_id IN (
  '50000000-0000-4000-8000-c00b00000007',
  '50000000-1000-4000-8000-c00b00000007',
  '50000000-2000-4000-8000-c00b00000007',
  '50000000-3000-4000-8000-c00b00000007',
  '50000000-4000-4000-8000-c00b00000007'
);

DELETE FROM corporation_members WHERE corp_id IN (
  '50000000-0000-4000-8000-c00b00000007',
  '50000000-1000-4000-8000-c00b00000007',
  '50000000-2000-4000-8000-c00b00000007',
  '50000000-3000-4000-8000-c00b00000007',
  '50000000-4000-4000-8000-c00b00000007'
);

-- Drop FK references from characters before deleting ships/corps they point to
DELETE FROM ship_instances WHERE owner_character_id IN (
  '50000000-0000-4000-8000-000000000007',
  '50000000-1000-4000-8000-000000000007',
  '50000000-2000-4000-8000-000000000007',
  '50000000-3000-4000-8000-000000000007',
  '50000000-4000-4000-8000-000000000007'
);
DELETE FROM ship_instances WHERE owner_corporation_id IN (
  '50000000-0000-4000-8000-c00b00000007',
  '50000000-1000-4000-8000-c00b00000007',
  '50000000-2000-4000-8000-c00b00000007',
  '50000000-3000-4000-8000-c00b00000007',
  '50000000-4000-4000-8000-c00b00000007'
);
UPDATE characters SET corporation_id = NULL WHERE character_id IN (
  '50000000-0000-4000-8000-000000000007',
  '50000000-1000-4000-8000-000000000007',
  '50000000-2000-4000-8000-000000000007',
  '50000000-3000-4000-8000-000000000007',
  '50000000-4000-4000-8000-000000000007'
);
-- Corporations must be deleted BEFORE the characters they reference as founder.
DELETE FROM corporations WHERE corp_id IN (
  '50000000-0000-4000-8000-c00b00000007',
  '50000000-1000-4000-8000-c00b00000007',
  '50000000-2000-4000-8000-c00b00000007',
  '50000000-3000-4000-8000-c00b00000007',
  '50000000-4000-4000-8000-c00b00000007'
);
DELETE FROM characters WHERE character_id IN (
  '50000000-0000-4000-8000-000000000007',
  '50000000-1000-4000-8000-000000000007',
  '50000000-2000-4000-8000-000000000007',
  '50000000-3000-4000-8000-000000000007',
  '50000000-4000-4000-8000-000000000007'
);

-- ── SEED ──────────────────────────────────────────────────────────────
-- Base sigma eval auth user (idempotent — re-running is safe).
INSERT INTO auth.users (id, email, aud, role, is_sso_user, is_anonymous) VALUES
  ('50000000-0000-4aaa-8000-000000000007', 'sigma-eval@gradientbang.com', 'authenticated', 'authenticated', false, false)
ON CONFLICT (id) DO NOTHING;

-- Characters first (founders must exist before corporations reference them).
-- map_knowledge: knows sectors 0, 15, 42 so initial status / plot_course resolve.
INSERT INTO characters (character_id, name, credits_in_megabank, map_knowledge) VALUES
  ('50000000-0000-4000-8000-000000000007', 'Sigma Fleet Eval0', 25000, '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'),
  ('50000000-1000-4000-8000-000000000007', 'Sigma Fleet Eval1', 25000, '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'),
  ('50000000-2000-4000-8000-000000000007', 'Sigma Fleet Eval2', 25000, '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'),
  ('50000000-3000-4000-8000-000000000007', 'Sigma Fleet Eval3', 25000, '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}'),
  ('50000000-4000-4000-8000-000000000007', 'Sigma Fleet Eval4', 25000, '{"total_sectors_visited": 3, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}, "15": {"adjacent_sectors": [0, 1], "last_visited": "2026-04-09T00:00:00Z", "position": [16, 30]}, "42": {"adjacent_sectors": [21, 32], "last_visited": "2026-04-08T00:00:00Z", "position": [14, 16]}}}');

-- Each Sigma founds its own Sigma Fleet corp.
INSERT INTO corporations (corp_id, name, founder_id, invite_code) VALUES
  ('50000000-0000-4000-8000-c00b00000007', 'Sigma Fleet 0', '50000000-0000-4000-8000-000000000007', 'SIGMA0'),
  ('50000000-1000-4000-8000-c00b00000007', 'Sigma Fleet 1', '50000000-1000-4000-8000-000000000007', 'SIGMA1'),
  ('50000000-2000-4000-8000-c00b00000007', 'Sigma Fleet 2', '50000000-2000-4000-8000-000000000007', 'SIGMA2'),
  ('50000000-3000-4000-8000-c00b00000007', 'Sigma Fleet 3', '50000000-3000-4000-8000-000000000007', 'SIGMA3'),
  ('50000000-4000-4000-8000-c00b00000007', 'Sigma Fleet 4', '50000000-4000-4000-8000-000000000007', 'SIGMA4');

UPDATE characters SET corporation_id = '50000000-0000-4000-8000-c00b00000007' WHERE character_id = '50000000-0000-4000-8000-000000000007';
UPDATE characters SET corporation_id = '50000000-1000-4000-8000-c00b00000007' WHERE character_id = '50000000-1000-4000-8000-000000000007';
UPDATE characters SET corporation_id = '50000000-2000-4000-8000-c00b00000007' WHERE character_id = '50000000-2000-4000-8000-000000000007';
UPDATE characters SET corporation_id = '50000000-3000-4000-8000-c00b00000007' WHERE character_id = '50000000-3000-4000-8000-000000000007';
UPDATE characters SET corporation_id = '50000000-4000-4000-8000-c00b00000007' WHERE character_id = '50000000-4000-4000-8000-000000000007';

INSERT INTO corporation_members (corp_id, character_id) VALUES
  ('50000000-0000-4000-8000-c00b00000007', '50000000-0000-4000-8000-000000000007'),
  ('50000000-1000-4000-8000-c00b00000007', '50000000-1000-4000-8000-000000000007'),
  ('50000000-2000-4000-8000-c00b00000007', '50000000-2000-4000-8000-000000000007'),
  ('50000000-3000-4000-8000-c00b00000007', '50000000-3000-4000-8000-000000000007'),
  ('50000000-4000-4000-8000-c00b00000007', '50000000-4000-4000-8000-000000000007');

-- Personal ships: kestrel_courier in sector 0, 5k credits.
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES
  ('50000000-0000-4000-8000-f00000000001', '50000000-0000-4000-8000-000000000007', 'character', '50000000-0000-4000-8000-000000000007', 'kestrel_courier', 0, 5000, 500, 150, 300),
  ('50000000-1000-4000-8000-f00000000001', '50000000-1000-4000-8000-000000000007', 'character', '50000000-1000-4000-8000-000000000007', 'kestrel_courier', 0, 5000, 500, 150, 300),
  ('50000000-2000-4000-8000-f00000000001', '50000000-2000-4000-8000-000000000007', 'character', '50000000-2000-4000-8000-000000000007', 'kestrel_courier', 0, 5000, 500, 150, 300),
  ('50000000-3000-4000-8000-f00000000001', '50000000-3000-4000-8000-000000000007', 'character', '50000000-3000-4000-8000-000000000007', 'kestrel_courier', 0, 5000, 500, 150, 300),
  ('50000000-4000-4000-8000-f00000000001', '50000000-4000-4000-8000-000000000007', 'character', '50000000-4000-4000-8000-000000000007', 'kestrel_courier', 0, 5000, 500, 150, 300);

-- Corp ship 1: "Kestrel-1" (autonomous_light_hauler) at sector 0, 10k credits.
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_corporation_id,
  ship_type, ship_name, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES
  ('50000000-0000-4000-8000-f00000000002', '50000000-0000-4000-8000-c00b00000007', 'corporation', '50000000-0000-4000-8000-c00b00000007', 'autonomous_light_hauler', 'Kestrel-1', 0, 10000, 500, 0, 0),
  ('50000000-1000-4000-8000-f00000000002', '50000000-1000-4000-8000-c00b00000007', 'corporation', '50000000-1000-4000-8000-c00b00000007', 'autonomous_light_hauler', 'Kestrel-1', 0, 10000, 500, 0, 0),
  ('50000000-2000-4000-8000-f00000000002', '50000000-2000-4000-8000-c00b00000007', 'corporation', '50000000-2000-4000-8000-c00b00000007', 'autonomous_light_hauler', 'Kestrel-1', 0, 10000, 500, 0, 0),
  ('50000000-3000-4000-8000-f00000000002', '50000000-3000-4000-8000-c00b00000007', 'corporation', '50000000-3000-4000-8000-c00b00000007', 'autonomous_light_hauler', 'Kestrel-1', 0, 10000, 500, 0, 0),
  ('50000000-4000-4000-8000-f00000000002', '50000000-4000-4000-8000-c00b00000007', 'corporation', '50000000-4000-4000-8000-c00b00000007', 'autonomous_light_hauler', 'Kestrel-1', 0, 10000, 500, 0, 0);

-- Corp ship 2: "Kestrel-2" (autonomous_light_hauler) at sector 0, 10k credits.
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_corporation_id,
  ship_type, ship_name, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES
  ('50000000-0000-4000-8000-f00000000003', '50000000-0000-4000-8000-c00b00000007', 'corporation', '50000000-0000-4000-8000-c00b00000007', 'autonomous_light_hauler', 'Kestrel-2', 0, 10000, 500, 0, 0),
  ('50000000-1000-4000-8000-f00000000003', '50000000-1000-4000-8000-c00b00000007', 'corporation', '50000000-1000-4000-8000-c00b00000007', 'autonomous_light_hauler', 'Kestrel-2', 0, 10000, 500, 0, 0),
  ('50000000-2000-4000-8000-f00000000003', '50000000-2000-4000-8000-c00b00000007', 'corporation', '50000000-2000-4000-8000-c00b00000007', 'autonomous_light_hauler', 'Kestrel-2', 0, 10000, 500, 0, 0),
  ('50000000-3000-4000-8000-f00000000003', '50000000-3000-4000-8000-c00b00000007', 'corporation', '50000000-3000-4000-8000-c00b00000007', 'autonomous_light_hauler', 'Kestrel-2', 0, 10000, 500, 0, 0),
  ('50000000-4000-4000-8000-f00000000003', '50000000-4000-4000-8000-c00b00000007', 'corporation', '50000000-4000-4000-8000-c00b00000007', 'autonomous_light_hauler', 'Kestrel-2', 0, 10000, 500, 0, 0);

-- Corp ship 3: "Audit Spectre" (autonomous_light_hauler) at sector 0, 10k credits.
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_corporation_id,
  ship_type, ship_name, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES
  ('50000000-0000-4000-8000-f00000000004', '50000000-0000-4000-8000-c00b00000007', 'corporation', '50000000-0000-4000-8000-c00b00000007', 'autonomous_light_hauler', 'Audit Spectre', 0, 10000, 500, 0, 0),
  ('50000000-1000-4000-8000-f00000000004', '50000000-1000-4000-8000-c00b00000007', 'corporation', '50000000-1000-4000-8000-c00b00000007', 'autonomous_light_hauler', 'Audit Spectre', 0, 10000, 500, 0, 0),
  ('50000000-2000-4000-8000-f00000000004', '50000000-2000-4000-8000-c00b00000007', 'corporation', '50000000-2000-4000-8000-c00b00000007', 'autonomous_light_hauler', 'Audit Spectre', 0, 10000, 500, 0, 0),
  ('50000000-3000-4000-8000-f00000000004', '50000000-3000-4000-8000-c00b00000007', 'corporation', '50000000-3000-4000-8000-c00b00000007', 'autonomous_light_hauler', 'Audit Spectre', 0, 10000, 500, 0, 0),
  ('50000000-4000-4000-8000-f00000000004', '50000000-4000-4000-8000-c00b00000007', 'corporation', '50000000-4000-4000-8000-c00b00000007', 'autonomous_light_hauler', 'Audit Spectre', 0, 10000, 500, 0, 0);

-- Register all 3 corp ships with their respective corps.
INSERT INTO corporation_ships (corp_id, ship_id, added_by) VALUES
  ('50000000-0000-4000-8000-c00b00000007', '50000000-0000-4000-8000-f00000000002', '50000000-0000-4000-8000-000000000007'),
  ('50000000-0000-4000-8000-c00b00000007', '50000000-0000-4000-8000-f00000000003', '50000000-0000-4000-8000-000000000007'),
  ('50000000-0000-4000-8000-c00b00000007', '50000000-0000-4000-8000-f00000000004', '50000000-0000-4000-8000-000000000007'),
  ('50000000-1000-4000-8000-c00b00000007', '50000000-1000-4000-8000-f00000000002', '50000000-1000-4000-8000-000000000007'),
  ('50000000-1000-4000-8000-c00b00000007', '50000000-1000-4000-8000-f00000000003', '50000000-1000-4000-8000-000000000007'),
  ('50000000-1000-4000-8000-c00b00000007', '50000000-1000-4000-8000-f00000000004', '50000000-1000-4000-8000-000000000007'),
  ('50000000-2000-4000-8000-c00b00000007', '50000000-2000-4000-8000-f00000000002', '50000000-2000-4000-8000-000000000007'),
  ('50000000-2000-4000-8000-c00b00000007', '50000000-2000-4000-8000-f00000000003', '50000000-2000-4000-8000-000000000007'),
  ('50000000-2000-4000-8000-c00b00000007', '50000000-2000-4000-8000-f00000000004', '50000000-2000-4000-8000-000000000007'),
  ('50000000-3000-4000-8000-c00b00000007', '50000000-3000-4000-8000-f00000000002', '50000000-3000-4000-8000-000000000007'),
  ('50000000-3000-4000-8000-c00b00000007', '50000000-3000-4000-8000-f00000000003', '50000000-3000-4000-8000-000000000007'),
  ('50000000-3000-4000-8000-c00b00000007', '50000000-3000-4000-8000-f00000000004', '50000000-3000-4000-8000-000000000007'),
  ('50000000-4000-4000-8000-c00b00000007', '50000000-4000-4000-8000-f00000000002', '50000000-4000-4000-8000-000000000007'),
  ('50000000-4000-4000-8000-c00b00000007', '50000000-4000-4000-8000-f00000000003', '50000000-4000-4000-8000-000000000007'),
  ('50000000-4000-4000-8000-c00b00000007', '50000000-4000-4000-8000-f00000000004', '50000000-4000-4000-8000-000000000007');

-- Set active personal ship.
UPDATE characters SET current_ship_id = '50000000-0000-4000-8000-f00000000001' WHERE character_id = '50000000-0000-4000-8000-000000000007';
UPDATE characters SET current_ship_id = '50000000-1000-4000-8000-f00000000001' WHERE character_id = '50000000-1000-4000-8000-000000000007';
UPDATE characters SET current_ship_id = '50000000-2000-4000-8000-f00000000001' WHERE character_id = '50000000-2000-4000-8000-000000000007';
UPDATE characters SET current_ship_id = '50000000-3000-4000-8000-f00000000001' WHERE character_id = '50000000-3000-4000-8000-000000000007';
UPDATE characters SET current_ship_id = '50000000-4000-4000-8000-f00000000001' WHERE character_id = '50000000-4000-4000-8000-000000000007';

-- All 5 slots linked to the shared sigma eval auth user (exactly at the 5-character cap).
INSERT INTO user_characters (user_id, character_id) VALUES
  ('50000000-0000-4aaa-8000-000000000007', '50000000-0000-4000-8000-000000000007'),
  ('50000000-0000-4aaa-8000-000000000007', '50000000-1000-4000-8000-000000000007'),
  ('50000000-0000-4aaa-8000-000000000007', '50000000-2000-4000-8000-000000000007'),
  ('50000000-0000-4aaa-8000-000000000007', '50000000-3000-4000-8000-000000000007'),
  ('50000000-0000-4aaa-8000-000000000007', '50000000-4000-4000-8000-000000000007');

-- Give every character knowledge of one mega-port so list_known_ports(mega=true) resolves.
DO $sigma_mega_port$
DECLARE
  v_mega_port INT;
  v_adj JSONB;
  v_pos JSONB;
  v_sector_entry JSONB;
  v_char_ids UUID[] := ARRAY[
    '50000000-0000-4000-8000-000000000007'::uuid,
    '50000000-1000-4000-8000-000000000007'::uuid,
    '50000000-2000-4000-8000-000000000007'::uuid,
    '50000000-3000-4000-8000-000000000007'::uuid,
    '50000000-4000-4000-8000-000000000007'::uuid
  ];
  v_char_id UUID;
BEGIN
  SELECT sector_id INTO v_mega_port
    FROM sectors WHERE region = 'fedspace' AND has_mega_port = true
    ORDER BY sector_id LIMIT 1;
  IF v_mega_port IS NULL THEN
    RAISE NOTICE 'sigma_fleet seed: no mega-port sectors found, skipping map_knowledge augmentation';
    RETURN;
  END IF;

  SELECT to_jsonb(array_agg(adj_sector_id))
    INTO v_adj
    FROM sector_warps WHERE sector_id = v_mega_port;
  v_adj := COALESCE(v_adj, '[]'::jsonb);
  SELECT to_jsonb(ARRAY[col, row])
    INTO v_pos
    FROM sectors WHERE sector_id = v_mega_port;
  v_pos := COALESCE(v_pos, '[0, 0]'::jsonb);

  v_sector_entry := jsonb_build_object(
    'adjacent_sectors', v_adj,
    'last_visited', '2026-04-10T00:00:00Z',
    'position', v_pos
  );

  FOREACH v_char_id IN ARRAY v_char_ids LOOP
    UPDATE characters
      SET map_knowledge = jsonb_set(
        COALESCE(map_knowledge, '{"total_sectors_visited": 0, "sectors_visited": {}}'::jsonb),
        ARRAY['sectors_visited', v_mega_port::text],
        v_sector_entry,
        true
      )
      WHERE character_id = v_char_id;
  END LOOP;
END $sigma_mega_port$;

-- Seed a prior-session history so event-log queries return non-empty.
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
  '{"source": "sigma-fleet-eval-seed"}'::jsonb
FROM (VALUES
  ('50000000-0000-4000-8000-000000000007'::uuid, 0, '50000000-0000-4000-8000-f00000000001'::uuid),
  ('50000000-1000-4000-8000-000000000007'::uuid, 0, '50000000-1000-4000-8000-f00000000001'::uuid),
  ('50000000-2000-4000-8000-000000000007'::uuid, 0, '50000000-2000-4000-8000-f00000000001'::uuid),
  ('50000000-3000-4000-8000-000000000007'::uuid, 0, '50000000-3000-4000-8000-f00000000001'::uuid),
  ('50000000-4000-4000-8000-000000000007'::uuid, 0, '50000000-4000-4000-8000-f00000000001'::uuid)
) AS v(character_id, sector_id, ship_id)
CROSS JOIN (VALUES
  ('session.started', INTERVAL '0 minutes', '{"source": "seed", "sector": 0, "ship_name": "Kestrel Courier", "ship_type": "kestrel_courier"}'),
  ('task.finish',     INTERVAL '10 minutes', '{"task_summary": "Surveyed nearby sectors with Audit Spectre.", "task_status": "completed"}')
) AS e(event_type, offset_interval, payload);

COMMIT;
`;
