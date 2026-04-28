// Generated from tests/eval/webhook_server/seeds/kappa_combat.sql
// Do not edit directly — run: bash scripts/sync-eval-seeds.sh
export const sql = `
-- Kappa Combat Eval — voice-initiated 1v1 combat world
-- Seeds 5 variations (Eval0..Eval4) of a commander (P1) and a peer target (P2)
-- co-located in a non-fedspace sector so combat_initiate fires without being
-- blocked by Federation Space rules. Neither side is in a corporation.
--
-- Namespace 1b* (next free hex-valid eval world after Orion Vale's 1a*).
-- Sub-namespaces inside 1b: 1b0* (P1 commander + ship), 1b1* (P2 target + ship).
--
-- P1: sparrow_scout with 100 fighters (matches scenario 1.1 description)
-- P2: sparrow_scout with 80 fighters — armed, valid combat target
-- Sector: chosen at seed time as the lowest-numbered DEEP-NEUTRAL sector
-- (not fedspace, not mega-port, not sector 0, not a border sector with a
-- direct warp to fedspace) that has at least one warp. The seed RAISES
-- EXCEPTION if no such sector exists — better to fail loudly than to leave
-- ships in fedspace and have combat silently refuse at runtime.
--
-- Usage: psql $LOCAL_API_POSTGRES_URL -f seeds/kappa_combat.sql

BEGIN;

-- ── TEARDOWN ──────────────────────────────────────────────────────────

-- P1 commanders
DELETE FROM events WHERE character_id IN (
  '1b000000-0000-4000-8000-000000000001',
  '1b000000-1000-4000-8000-000000000001',
  '1b000000-2000-4000-8000-000000000001',
  '1b000000-3000-4000-8000-000000000001',
  '1b000000-4000-4000-8000-000000000001'
);
DELETE FROM events WHERE sender_id IN (
  '1b000000-0000-4000-8000-000000000001',
  '1b000000-1000-4000-8000-000000000001',
  '1b000000-2000-4000-8000-000000000001',
  '1b000000-3000-4000-8000-000000000001',
  '1b000000-4000-4000-8000-000000000001'
);
DELETE FROM events WHERE ship_id IN (
  SELECT ship_id FROM ship_instances WHERE owner_character_id IN (
    '1b000000-0000-4000-8000-000000000001',
    '1b000000-1000-4000-8000-000000000001',
    '1b000000-2000-4000-8000-000000000001',
    '1b000000-3000-4000-8000-000000000001',
    '1b000000-4000-4000-8000-000000000001'
  )
);
DELETE FROM user_characters WHERE character_id IN (
  '1b000000-0000-4000-8000-000000000001',
  '1b000000-1000-4000-8000-000000000001',
  '1b000000-2000-4000-8000-000000000001',
  '1b000000-3000-4000-8000-000000000001',
  '1b000000-4000-4000-8000-000000000001'
);
UPDATE characters SET current_ship_id = NULL WHERE character_id IN (
  '1b000000-0000-4000-8000-000000000001',
  '1b000000-1000-4000-8000-000000000001',
  '1b000000-2000-4000-8000-000000000001',
  '1b000000-3000-4000-8000-000000000001',
  '1b000000-4000-4000-8000-000000000001'
);
DELETE FROM ship_instances WHERE owner_character_id IN (
  '1b000000-0000-4000-8000-000000000001',
  '1b000000-1000-4000-8000-000000000001',
  '1b000000-2000-4000-8000-000000000001',
  '1b000000-3000-4000-8000-000000000001',
  '1b000000-4000-4000-8000-000000000001'
);
DELETE FROM characters WHERE character_id IN (
  '1b000000-0000-4000-8000-000000000001',
  '1b000000-1000-4000-8000-000000000001',
  '1b000000-2000-4000-8000-000000000001',
  '1b000000-3000-4000-8000-000000000001',
  '1b000000-4000-4000-8000-000000000001'
);

-- P2 peer targets
DELETE FROM events WHERE character_id IN (
  '1b100000-0000-4000-8000-000000000001',
  '1b100000-1000-4000-8000-000000000001',
  '1b100000-2000-4000-8000-000000000001',
  '1b100000-3000-4000-8000-000000000001',
  '1b100000-4000-4000-8000-000000000001'
);
DELETE FROM events WHERE sender_id IN (
  '1b100000-0000-4000-8000-000000000001',
  '1b100000-1000-4000-8000-000000000001',
  '1b100000-2000-4000-8000-000000000001',
  '1b100000-3000-4000-8000-000000000001',
  '1b100000-4000-4000-8000-000000000001'
);
DELETE FROM events WHERE ship_id IN (
  SELECT ship_id FROM ship_instances WHERE owner_character_id IN (
    '1b100000-0000-4000-8000-000000000001',
    '1b100000-1000-4000-8000-000000000001',
    '1b100000-2000-4000-8000-000000000001',
    '1b100000-3000-4000-8000-000000000001',
    '1b100000-4000-4000-8000-000000000001'
  )
);
DELETE FROM user_characters WHERE character_id IN (
  '1b100000-0000-4000-8000-000000000001',
  '1b100000-1000-4000-8000-000000000001',
  '1b100000-2000-4000-8000-000000000001',
  '1b100000-3000-4000-8000-000000000001',
  '1b100000-4000-4000-8000-000000000001'
);
UPDATE characters SET current_ship_id = NULL WHERE character_id IN (
  '1b100000-0000-4000-8000-000000000001',
  '1b100000-1000-4000-8000-000000000001',
  '1b100000-2000-4000-8000-000000000001',
  '1b100000-3000-4000-8000-000000000001',
  '1b100000-4000-4000-8000-000000000001'
);
DELETE FROM ship_instances WHERE owner_character_id IN (
  '1b100000-0000-4000-8000-000000000001',
  '1b100000-1000-4000-8000-000000000001',
  '1b100000-2000-4000-8000-000000000001',
  '1b100000-3000-4000-8000-000000000001',
  '1b100000-4000-4000-8000-000000000001'
);
DELETE FROM characters WHERE character_id IN (
  '1b100000-0000-4000-8000-000000000001',
  '1b100000-1000-4000-8000-000000000001',
  '1b100000-2000-4000-8000-000000000001',
  '1b100000-3000-4000-8000-000000000001',
  '1b100000-4000-4000-8000-000000000001'
);

-- ── SEED: AUTH USERS ─────────────────────────────────────────────────
-- One user per side (5-char cap fits 5 variations exactly).

INSERT INTO auth.users (id, email, aud, role, is_sso_user, is_anonymous) VALUES
  ('1b000000-1b00-4aaa-8000-000000000001', 'kappa-eval-base@gradientbang.com',        'authenticated', 'authenticated', false, false),
  ('1b100000-1b00-4aaa-8000-000000000001', 'kappa-target-eval-base@gradientbang.com', 'authenticated', 'authenticated', false, false)
ON CONFLICT (id) DO NOTHING;

-- ── SEED: P1 COMMANDERS (Kappa Combat Eval0..4) ──────────────────────

INSERT INTO characters (character_id, name, map_knowledge) VALUES
  ('1b000000-0000-4000-8000-000000000001', 'Kappa Combat Eval0', '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('1b000000-1000-4000-8000-000000000001', 'Kappa Combat Eval1', '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('1b000000-2000-4000-8000-000000000001', 'Kappa Combat Eval2', '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('1b000000-3000-4000-8000-000000000001', 'Kappa Combat Eval3', '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('1b000000-4000-4000-8000-000000000001', 'Kappa Combat Eval4', '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}');

-- P1 ships (sparrow_scout with 100 fighters per scenario 1.1)
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES
  ('1b000000-0000-4000-8000-1b0000000001', '1b000000-0000-4000-8000-000000000001', 'character', '1b000000-0000-4000-8000-000000000001', 'sparrow_scout', 0, 5000, 450, 120, 100),
  ('1b000000-1000-4000-8000-1b0000000001', '1b000000-1000-4000-8000-000000000001', 'character', '1b000000-1000-4000-8000-000000000001', 'sparrow_scout', 0, 5000, 450, 120, 100),
  ('1b000000-2000-4000-8000-1b0000000001', '1b000000-2000-4000-8000-000000000001', 'character', '1b000000-2000-4000-8000-000000000001', 'sparrow_scout', 0, 5000, 450, 120, 100),
  ('1b000000-3000-4000-8000-1b0000000001', '1b000000-3000-4000-8000-000000000001', 'character', '1b000000-3000-4000-8000-000000000001', 'sparrow_scout', 0, 5000, 450, 120, 100),
  ('1b000000-4000-4000-8000-1b0000000001', '1b000000-4000-4000-8000-000000000001', 'character', '1b000000-4000-4000-8000-000000000001', 'sparrow_scout', 0, 5000, 450, 120, 100);

UPDATE characters SET current_ship_id = '1b000000-0000-4000-8000-1b0000000001' WHERE character_id = '1b000000-0000-4000-8000-000000000001';
UPDATE characters SET current_ship_id = '1b000000-1000-4000-8000-1b0000000001' WHERE character_id = '1b000000-1000-4000-8000-000000000001';
UPDATE characters SET current_ship_id = '1b000000-2000-4000-8000-1b0000000001' WHERE character_id = '1b000000-2000-4000-8000-000000000001';
UPDATE characters SET current_ship_id = '1b000000-3000-4000-8000-1b0000000001' WHERE character_id = '1b000000-3000-4000-8000-000000000001';
UPDATE characters SET current_ship_id = '1b000000-4000-4000-8000-1b0000000001' WHERE character_id = '1b000000-4000-4000-8000-000000000001';

INSERT INTO user_characters (user_id, character_id) VALUES
  ('1b000000-1b00-4aaa-8000-000000000001', '1b000000-0000-4000-8000-000000000001'),
  ('1b000000-1b00-4aaa-8000-000000000001', '1b000000-1000-4000-8000-000000000001'),
  ('1b000000-1b00-4aaa-8000-000000000001', '1b000000-2000-4000-8000-000000000001'),
  ('1b000000-1b00-4aaa-8000-000000000001', '1b000000-3000-4000-8000-000000000001'),
  ('1b000000-1b00-4aaa-8000-000000000001', '1b000000-4000-4000-8000-000000000001');

-- ── SEED: P2 PEER TARGETS (Kappa Target Eval0..4) ────────────────────

INSERT INTO characters (character_id, name, map_knowledge) VALUES
  ('1b100000-0000-4000-8000-000000000001', 'Kappa Target Eval0', '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('1b100000-1000-4000-8000-000000000001', 'Kappa Target Eval1', '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('1b100000-2000-4000-8000-000000000001', 'Kappa Target Eval2', '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('1b100000-3000-4000-8000-000000000001', 'Kappa Target Eval3', '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'),
  ('1b100000-4000-4000-8000-000000000001', 'Kappa Target Eval4', '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}');

-- P2 ships (sparrow_scout with 80 fighters — armed, valid target)
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES
  ('1b100000-0000-4000-8000-1b1000000001', '1b100000-0000-4000-8000-000000000001', 'character', '1b100000-0000-4000-8000-000000000001', 'sparrow_scout', 0, 1000, 300, 100, 80),
  ('1b100000-1000-4000-8000-1b1000000001', '1b100000-1000-4000-8000-000000000001', 'character', '1b100000-1000-4000-8000-000000000001', 'sparrow_scout', 0, 1000, 300, 100, 80),
  ('1b100000-2000-4000-8000-1b1000000001', '1b100000-2000-4000-8000-000000000001', 'character', '1b100000-2000-4000-8000-000000000001', 'sparrow_scout', 0, 1000, 300, 100, 80),
  ('1b100000-3000-4000-8000-1b1000000001', '1b100000-3000-4000-8000-000000000001', 'character', '1b100000-3000-4000-8000-000000000001', 'sparrow_scout', 0, 1000, 300, 100, 80),
  ('1b100000-4000-4000-8000-1b1000000001', '1b100000-4000-4000-8000-000000000001', 'character', '1b100000-4000-4000-8000-000000000001', 'sparrow_scout', 0, 1000, 300, 100, 80);

UPDATE characters SET current_ship_id = '1b100000-0000-4000-8000-1b1000000001' WHERE character_id = '1b100000-0000-4000-8000-000000000001';
UPDATE characters SET current_ship_id = '1b100000-1000-4000-8000-1b1000000001' WHERE character_id = '1b100000-1000-4000-8000-000000000001';
UPDATE characters SET current_ship_id = '1b100000-2000-4000-8000-1b1000000001' WHERE character_id = '1b100000-2000-4000-8000-000000000001';
UPDATE characters SET current_ship_id = '1b100000-3000-4000-8000-1b1000000001' WHERE character_id = '1b100000-3000-4000-8000-000000000001';
UPDATE characters SET current_ship_id = '1b100000-4000-4000-8000-1b1000000001' WHERE character_id = '1b100000-4000-4000-8000-000000000001';

INSERT INTO user_characters (user_id, character_id) VALUES
  ('1b100000-1b00-4aaa-8000-000000000001', '1b100000-0000-4000-8000-000000000001'),
  ('1b100000-1b00-4aaa-8000-000000000001', '1b100000-1000-4000-8000-000000000001'),
  ('1b100000-1b00-4aaa-8000-000000000001', '1b100000-2000-4000-8000-000000000001'),
  ('1b100000-1b00-4aaa-8000-000000000001', '1b100000-3000-4000-8000-000000000001'),
  ('1b100000-1b00-4aaa-8000-000000000001', '1b100000-4000-4000-8000-000000000001');

-- ── RELOCATE TO DEEP-NEUTRAL SECTOR ──────────────────────────────────
-- Combat is blocked in Federation Space. Pick a sector that is:
--   (a) not in universe_config.fedspace_sectors
--   (b) not in universe_config.mega_port_sectors (mega-ports live in fedspace)
--   (c) not sector 0 (always fedspace by game convention)
--   (d) has at least one warp
--   (e) NOT a border sector — none of its warp targets are in fedspace
-- The border-sector exclusion is defensive: combat is technically allowed in
-- Neutral border sectors, but several status-snapshot codepaths label them
-- visually as "near Federation Space" which has confused the voice agent
-- in past runs. Picking a deep-neutral sector avoids that whole class of
-- failure. RAISE EXCEPTION (not NOTICE) on miss so the seed loudly fails
-- instead of silently leaving ships in fedspace at sector 0.

DO $kappa_nonfed_relocate$
DECLARE
  v_fed JSONB;
  v_mega JSONB;
  v_sector INT;
  v_adj JSONB;
  v_pos JSONB;
  v_sector_entry JSONB;
  v_p1_chars UUID[] := ARRAY[
    '1b000000-0000-4000-8000-000000000001'::uuid,
    '1b000000-1000-4000-8000-000000000001'::uuid,
    '1b000000-2000-4000-8000-000000000001'::uuid,
    '1b000000-3000-4000-8000-000000000001'::uuid,
    '1b000000-4000-4000-8000-000000000001'::uuid
  ];
  v_p2_chars UUID[] := ARRAY[
    '1b100000-0000-4000-8000-000000000001'::uuid,
    '1b100000-1000-4000-8000-000000000001'::uuid,
    '1b100000-2000-4000-8000-000000000001'::uuid,
    '1b100000-3000-4000-8000-000000000001'::uuid,
    '1b100000-4000-4000-8000-000000000001'::uuid
  ];
  v_all_ships UUID[] := ARRAY[
    '1b000000-0000-4000-8000-1b0000000001'::uuid,
    '1b000000-1000-4000-8000-1b0000000001'::uuid,
    '1b000000-2000-4000-8000-1b0000000001'::uuid,
    '1b000000-3000-4000-8000-1b0000000001'::uuid,
    '1b000000-4000-4000-8000-1b0000000001'::uuid,
    '1b100000-0000-4000-8000-1b1000000001'::uuid,
    '1b100000-1000-4000-8000-1b1000000001'::uuid,
    '1b100000-2000-4000-8000-1b1000000001'::uuid,
    '1b100000-3000-4000-8000-1b1000000001'::uuid,
    '1b100000-4000-4000-8000-1b1000000001'::uuid
  ];
BEGIN
  SELECT
    COALESCE(meta->'fedspace_sectors',  '[]'::jsonb),
    COALESCE(meta->'mega_port_sectors', '[]'::jsonb)
  INTO v_fed, v_mega
  FROM universe_config WHERE id = 1;

  SELECT us.sector_id,
         COALESCE((SELECT jsonb_agg((w->>'to')::int) FROM jsonb_array_elements(us.warps) w), '[]'::jsonb),
         jsonb_build_array(us.position_x, us.position_y)
    INTO v_sector, v_adj, v_pos
    FROM universe_structure us
    WHERE jsonb_array_length(us.warps) > 0
      AND us.sector_id <> 0
      AND NOT (v_fed  @> to_jsonb(us.sector_id))
      AND NOT (v_mega @> to_jsonb(us.sector_id))
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(us.warps) w
        WHERE v_fed @> to_jsonb((w->>'to')::int)
      )
    ORDER BY us.sector_id
    LIMIT 1;

  IF v_sector IS NULL THEN
    RAISE EXCEPTION 'kappa_combat: no deep-neutral sector with warps found in universe_structure (fedspace_sectors=%, mega_port_sectors=%). Seed cannot guarantee combat-eligible sector; aborting.',
      v_fed, v_mega;
  END IF;

  RAISE NOTICE 'kappa_combat: relocating ships to deep-neutral sector %', v_sector;

  UPDATE ship_instances SET current_sector = v_sector
    WHERE ship_id = ANY(v_all_ships);

  v_sector_entry := jsonb_build_object(
    'adjacent_sectors', v_adj,
    'last_visited', (NOW() - INTERVAL '1 hour')::text,
    'position', v_pos
  );

  UPDATE characters
    SET map_knowledge = jsonb_set(
      COALESCE(map_knowledge, '{"sectors_visited": {}, "total_sectors_visited": 0}'::jsonb),
      ARRAY['sectors_visited', v_sector::text],
      v_sector_entry
    )
    WHERE character_id = ANY(v_p1_chars) OR character_id = ANY(v_p2_chars);
  UPDATE characters
    SET map_knowledge = jsonb_set(
      map_knowledge, '{total_sectors_visited}',
      to_jsonb((SELECT count(*) FROM jsonb_object_keys(map_knowledge->'sectors_visited')))
    )
    WHERE character_id = ANY(v_p1_chars) OR character_id = ANY(v_p2_chars);
END $kappa_nonfed_relocate$;

-- Backdate first_visit / created_at so the is_first_visit heuristic returns false.
UPDATE characters SET first_visit = NOW() - INTERVAL '1 day', created_at = NOW() - INTERVAL '1 day' WHERE character_id IN (
  '1b000000-0000-4000-8000-000000000001',
  '1b000000-1000-4000-8000-000000000001',
  '1b000000-2000-4000-8000-000000000001',
  '1b000000-3000-4000-8000-000000000001',
  '1b000000-4000-4000-8000-000000000001',
  '1b100000-0000-4000-8000-000000000001',
  '1b100000-1000-4000-8000-000000000001',
  '1b100000-2000-4000-8000-000000000001',
  '1b100000-3000-4000-8000-000000000001',
  '1b100000-4000-4000-8000-000000000001'
);

COMMIT;
`;
