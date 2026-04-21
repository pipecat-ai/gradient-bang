-- Seed dedicated auth.users for eval characters.
-- Idempotent — safe to re-run. Intended to be executed against the eval
-- environment before (or alongside) seed_eval_characters.sql.
--
-- Each eval character family (alpha, beta, gamma, delta, epsilon) gets its
-- own "base" auth user to hold its slots 0..4 (five characters). Without
-- these users, the 5-character-per-user trigger blocks a second family from
-- seeding onto a single shared eval user.
--
-- Phi retains its existing cf73d883-... base user (seeded elsewhere).
--
-- Slot-5+ overflow users are created inline by the per-character seed
-- scripts (see tests/eval/webhook_server/seeds/*.sql).
--
-- See tests/eval/README.md for the full user/character chart.
--
-- Usage: psql $LOCAL_API_POSTGRES_URL -f tests/eval/webhook_server/seed_add_eval_users.sql

BEGIN;

INSERT INTO auth.users (id, email, aud, role, is_sso_user, is_anonymous) VALUES
  ('a0000000-0000-4aaa-8000-000000000001', 'alpha-eval-base@gradientbang.com',   'authenticated', 'authenticated', false, false),
  ('b0000000-0000-4aaa-8000-000000000002', 'beta-eval-base@gradientbang.com',    'authenticated', 'authenticated', false, false),
  ('c0000000-0000-4aaa-8000-000000000003', 'gamma-eval-base@gradientbang.com',   'authenticated', 'authenticated', false, false),
  ('d0000000-0000-4aaa-8000-000000000004', 'delta-eval-base@gradientbang.com',   'authenticated', 'authenticated', false, false),
  ('e0000000-0000-4aaa-8000-000000000005', 'epsilon-eval-base@gradientbang.com', 'authenticated', 'authenticated', false, false)
ON CONFLICT (id) DO NOTHING;

COMMIT;
