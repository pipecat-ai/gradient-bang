-- Seed all eval characters (idempotent — safe to re-run)
-- Includes each per-character script, which seeds 5 variations (Eval0..Eval4).
-- Usage: psql $LOCAL_API_POSTGRES_URL -f seed_eval_characters.sql
-- To reset a single character group: psql $LOCAL_API_POSTGRES_URL -f seeds/<name>.sql

\i seeds/_shared_players.sql
\i seeds/alpha_sparrow.sql
\i seeds/beta_kestrel.sql
\i seeds/gamma_explorer.sql
\i seeds/delta_fleet.sql
\i seeds/epsilon_corp.sql
\i seeds/phi_trader.sql
