-- Shared eval players referenced by multiple per-character seed scripts.
-- Currently just "Starfall Eval" — a passive peer used in direct-message
-- scenarios (Beta 246182, Epsilon 246196). Other eval worlds (e.g. Orion Vale)
-- keep their own same-named characters under their own UUID namespace.
-- Usage: `\i seeds/_shared_players.sql` from seed_eval_characters.sql.

BEGIN;

DELETE FROM events WHERE character_id = '5fa11f00-0000-4000-8000-000000000001';
DELETE FROM events WHERE sender_id = '5fa11f00-0000-4000-8000-000000000001';
DELETE FROM events WHERE ship_id IN (
  SELECT ship_id FROM ship_instances WHERE owner_character_id = '5fa11f00-0000-4000-8000-000000000001'
);
DELETE FROM user_characters WHERE character_id = '5fa11f00-0000-4000-8000-000000000001';
UPDATE characters SET current_ship_id = NULL WHERE character_id = '5fa11f00-0000-4000-8000-000000000001';
DELETE FROM ship_instances WHERE owner_character_id = '5fa11f00-0000-4000-8000-000000000001';
DELETE FROM characters WHERE character_id = '5fa11f00-0000-4000-8000-000000000001';

INSERT INTO auth.users (id, email, aud, role, is_sso_user, is_anonymous) VALUES
  ('5fa11f00-0000-4aaa-8000-000000000001', 'starfall-shared@gradientbang.com', 'authenticated', 'authenticated', false, false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO characters (character_id, name, map_knowledge, player_metadata) VALUES (
  '5fa11f00-0000-4000-8000-000000000001',
  'Starfall',
  '{"total_sectors_visited": 1, "sectors_visited": {"0": {"adjacent_sectors": [], "last_visited": "2026-04-10T00:00:00Z", "position": [0, 0]}}}'::jsonb,
  '{"source": "shared-eval-seed", "role": "passive-peer"}'::jsonb
);

INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, current_sector, credits,
  current_warp_power, current_shields, current_fighters
) VALUES (
  '5fa11f00-0000-4000-8000-5fa11f000001',
  '5fa11f00-0000-4000-8000-000000000001', 'character', '5fa11f00-0000-4000-8000-000000000001',
  'sparrow_scout', 0, 0, 200, 100, 50
);

UPDATE characters SET current_ship_id = '5fa11f00-0000-4000-8000-5fa11f000001'
  WHERE character_id = '5fa11f00-0000-4000-8000-000000000001';

INSERT INTO user_characters (user_id, character_id) VALUES
  ('5fa11f00-0000-4aaa-8000-000000000001', '5fa11f00-0000-4000-8000-000000000001');

-- Backdate so is_first_visit heuristic returns false.
UPDATE characters SET first_visit = NOW() - INTERVAL '1 day', created_at = NOW() - INTERVAL '1 day'
  WHERE character_id = '5fa11f00-0000-4000-8000-000000000001';

COMMIT;
