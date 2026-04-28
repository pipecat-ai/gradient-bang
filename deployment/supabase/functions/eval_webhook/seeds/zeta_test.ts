// Generated from tests/eval/webhook_server/seeds/zeta_test.sql
// Do not edit directly — run: bash scripts/sync-eval-seeds.sh
export const sql = `
-- Zeta Test Eval — sparrow_scout, 10k credits, 2 known mega-ports
-- Single-slot seed in the 1b-prefix namespace (next eval world after Orion Vale's 1a*).
-- Inline auth user (zeta-test-eval@gradientbang.com) keeps this character isolated
-- from the shared eval users and their 5-character cap.
-- Usage: psql $LOCAL_API_POSTGRES_URL -f seeds/zeta_test.sql

BEGIN;

-- ── TEARDOWN ──────────────────────────────────────────────────────────

DELETE FROM events WHERE character_id = '1b000000-0000-4000-8000-000000000001';
DELETE FROM events WHERE sender_id    = '1b000000-0000-4000-8000-000000000001';
DELETE FROM events WHERE ship_id IN (
  SELECT ship_id FROM ship_instances WHERE owner_character_id = '1b000000-0000-4000-8000-000000000001'
);
DELETE FROM user_characters WHERE character_id = '1b000000-0000-4000-8000-000000000001';
UPDATE characters SET current_ship_id = NULL WHERE character_id = '1b000000-0000-4000-8000-000000000001';
DELETE FROM ship_instances WHERE owner_character_id = '1b000000-0000-4000-8000-000000000001';
DELETE FROM characters WHERE character_id = '1b000000-0000-4000-8000-000000000001';

-- ── SEED: AUTH USER ──────────────────────────────────────────────────

INSERT INTO auth.users (id, email, aud, role, is_sso_user, is_anonymous) VALUES
  ('1b000000-1b00-4aaa-8000-000000000001', 'zeta-test-eval@gradientbang.com', 'authenticated', 'authenticated', false, false)
ON CONFLICT (id) DO NOTHING;

-- ── SEED: CHARACTER ──────────────────────────────────────────────────

INSERT INTO characters (character_id, name, credits_in_megabank, map_knowledge) VALUES
  (
    '1b000000-0000-4000-8000-000000000001',
    'Zeta Test Eval0',
    0,
    '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [15], "last_visited": "2026-04-10T00:00:00Z", "position": [15, 31]}}}'
  );

-- ── SEED: SHIP ───────────────────────────────────────────────────────

INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES (
  '1b000000-0000-4000-8000-1b0000000001',
  '1b000000-0000-4000-8000-000000000001',
  'character',
  '1b000000-0000-4000-8000-000000000001',
  'sparrow_scout',
  0,
  10000,
  300,
  100,
  50
);

UPDATE characters
SET current_ship_id = '1b000000-0000-4000-8000-1b0000000001'
WHERE character_id = '1b000000-0000-4000-8000-000000000001';

INSERT INTO user_characters (user_id, character_id) VALUES
  ('1b000000-1b00-4aaa-8000-000000000001', '1b000000-0000-4000-8000-000000000001');

-- ── SEED: KNOWN MEGA-PORTS ───────────────────────────────────────────
-- Add the first two mega-ports from universe_config to map_knowledge so
-- list_known_ports(mega=true) and "find a mega-port" tasks resolve without
-- exploration. Skips silently if fewer than two mega-ports are configured.

DO $zeta_mega_ports$
DECLARE
  v_mega_ports INT[];
  v_sector INT;
  v_adj JSONB;
  v_pos JSONB;
  v_entry JSONB;
  v_char UUID := '1b000000-0000-4000-8000-000000000001';
BEGIN
  SELECT ARRAY(
    SELECT (val)::int
    FROM jsonb_array_elements_text(meta->'mega_port_sectors') AS val
    LIMIT 2
  )
  INTO v_mega_ports
  FROM universe_config WHERE id = 1;

  IF v_mega_ports IS NULL OR array_length(v_mega_ports, 1) IS NULL THEN
    RAISE NOTICE 'No mega-ports configured in universe_config; skipping mega-port knowledge seed.';
    RETURN;
  END IF;

  FOREACH v_sector IN ARRAY v_mega_ports LOOP
    SELECT
      COALESCE((SELECT jsonb_agg((w->>'to')::int) FROM jsonb_array_elements(warps) w), '[]'::jsonb),
      jsonb_build_array(position_x, position_y)
    INTO v_adj, v_pos
    FROM universe_structure WHERE sector_id = v_sector;

    IF v_adj IS NULL THEN
      CONTINUE;
    END IF;

    v_entry := jsonb_build_object(
      'adjacent_sectors', v_adj,
      'last_visited', (NOW() - INTERVAL '2 days')::text,
      'position', v_pos
    );

    UPDATE characters
    SET map_knowledge = jsonb_set(
      COALESCE(map_knowledge, '{"sectors_visited": {}, "total_sectors_visited": 0}'::jsonb),
      ARRAY['sectors_visited', v_sector::text],
      v_entry
    )
    WHERE character_id = v_char;
  END LOOP;

  UPDATE characters
  SET map_knowledge = jsonb_set(
    map_knowledge,
    '{total_sectors_visited}',
    to_jsonb((SELECT count(*) FROM jsonb_object_keys(map_knowledge->'sectors_visited')))
  )
  WHERE character_id = v_char;
END $zeta_mega_ports$;

-- Backdate first_visit / created_at so the join is_first_visit heuristic returns false.
UPDATE characters
SET first_visit = NOW() - INTERVAL '1 day',
    created_at  = NOW() - INTERVAL '1 day'
WHERE character_id = '1b000000-0000-4000-8000-000000000001';

COMMIT;
`;
