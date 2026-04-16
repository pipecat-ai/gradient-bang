-- Orion Vale Eval — voice-agent-full eval world
-- Seeds the full ecosystem needed by the 21 scenarios in Cekura folder `tarush`
-- (agent id 16197, named `gb-bot-eval-orion-vale` once renamed per migration plan).
--
-- Contains:
--   • Commander: Orion Vale (kestrel_courier, 28,450 credits on hand, 12k megabank)
--   • Peer characters: Starfall (passive), Drifter (hostile NPC in Orion's sector),
--     Nova Prime (founder of Stellar Traders, high bank), Moonshadow (2nd Night
--     Wardens member for kick scenarios)
--   • Two corporations: Night Wardens (Orion's, with corp ships Coco Probe-1 and
--     Light Hauler Alpha), Stellar Traders (Nova's, invite code `stellar-01`)
--   • 9 sectors with a mega-port at sector 305 in Federation Space
--   • One recent movement.complete event in sector 3150 for historical queries
--
-- Usage: psql $LOCAL_API_POSTGRES_URL -f seeds/orion_vale.sql
-- Re-running fully tears down owned rows and re-inserts — safe to run repeatedly.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- UUID MAP (1a-prefix namespace — Orion Vale's own hex-valid namespace,
-- reserved entirely for this seed. Future characters claim 1b, 1c, ...
-- Sub-namespaces inside 1a use the third hex digit: 1a0* (Orion + corps
-- + corp ships), 1a1* (Starfall), 1a2* (Drifter), 1a3* (Nova), 1a4* (Moonshadow).)
-- ══════════════════════════════════════════════════════════════════════
--   orion_vale (commander):           1a000000-0000-4000-8000-000000000001
--   orion_vale ship (kestrel):        1a000000-0000-4000-8000-5a8369000001
--   starfall (passive peer):          1a100000-0000-4000-8000-000000000001
--   starfall ship (sparrow):          1a100000-0000-4000-8000-000000000002
--   drifter (hostile NPC):            1a200000-0000-4000-8000-000000000001
--   drifter ship (Rust Fang):         1a200000-0000-4000-8000-000000000002
--   nova_prime (other corp founder):  1a300000-0000-4000-8000-000000000001
--   nova_prime ship (wayfarer):       1a300000-0000-4000-8000-000000000002
--   moonshadow (2nd corp member):     1a400000-0000-4000-8000-000000000001
--   moonshadow ship (sparrow):        1a400000-0000-4000-8000-000000000002
--   night_wardens (orion's corp):     1a000000-0000-4000-8000-c00000000001
--   stellar_traders (nova's corp):    1a000000-0000-4000-8000-c00000000002
--   coco_probe-1 (corp ship):         1a000000-0000-4000-8000-062cb6000001
--   light_hauler_alpha (corp ship):   1a000000-0000-4000-8000-0d91eb000001
--
-- Sectors used: 305 (mega-port/fedspace), 1704, 2880, 3149, 3150 (Orion's start),
--   3786 (border), 4200, 4202, 4867
-- ══════════════════════════════════════════════════════════════════════

-- ── TEARDOWN ──────────────────────────────────────────────────────────

-- 1. user_characters links (Drifter is NPC and not linked). Orion's world
-- uses its own auth user ('1a000000-1a00-4aaa-8000-000000000001') so it
-- doesn't bump up against the 5-character-per-user limit that applies to
-- the shared eval user.
DELETE FROM user_characters
WHERE user_id = '1a000000-1a00-4aaa-8000-000000000001'
  AND character_id IN (
    '1a000000-0000-4000-8000-000000000001',
    '1a100000-0000-4000-8000-000000000001',
    '1a300000-0000-4000-8000-000000000001',
    '1a400000-0000-4000-8000-000000000001'
  );

-- 2. Events referencing any owned ship or character
DELETE FROM events WHERE ship_id IN (
  SELECT ship_id FROM ship_instances WHERE owner_character_id IN (
    '1a000000-0000-4000-8000-000000000001',
    '1a100000-0000-4000-8000-000000000001',
    '1a200000-0000-4000-8000-000000000001',
    '1a300000-0000-4000-8000-000000000001',
    '1a400000-0000-4000-8000-000000000001'
  )
);
DELETE FROM events WHERE ship_id IN (
  SELECT ship_id FROM ship_instances WHERE owner_corporation_id IN (
    '1a000000-0000-4000-8000-c00000000001',
    '1a000000-0000-4000-8000-c00000000002'
  )
);
DELETE FROM events WHERE character_id IN (
  '1a000000-0000-4000-8000-000000000001',
  '1a100000-0000-4000-8000-000000000001',
  '1a200000-0000-4000-8000-000000000001',
  '1a300000-0000-4000-8000-000000000001',
  '1a400000-0000-4000-8000-000000000001'
);
DELETE FROM events WHERE sender_id IN (
  '1a000000-0000-4000-8000-000000000001',
  '1a100000-0000-4000-8000-000000000001',
  '1a200000-0000-4000-8000-000000000001',
  '1a300000-0000-4000-8000-000000000001',
  '1a400000-0000-4000-8000-000000000001'
);
-- Events also FK on corp_id (e.g. corp_invite.created); clear ours so the
-- subsequent corporations DELETE doesn't fail on dangling refs.
DELETE FROM events WHERE corp_id IN (
  '1a000000-0000-4000-8000-c00000000001',
  '1a000000-0000-4000-8000-c00000000002'
);

-- 3. Corp join rows
DELETE FROM corporation_ships WHERE corp_id IN (
  '1a000000-0000-4000-8000-c00000000001',
  '1a000000-0000-4000-8000-c00000000002'
);
DELETE FROM corporation_members WHERE corp_id IN (
  '1a000000-0000-4000-8000-c00000000001',
  '1a000000-0000-4000-8000-c00000000002'
);

-- 4. Null ship/corp FKs on characters before deleting ships/corps
UPDATE characters
SET current_ship_id = NULL, corporation_id = NULL
WHERE character_id IN (
  '1a000000-0000-4000-8000-000000000001',
  '1a100000-0000-4000-8000-000000000001',
  '1a200000-0000-4000-8000-000000000001',
  '1a300000-0000-4000-8000-000000000001',
  '1a400000-0000-4000-8000-000000000001'
);

-- 5. Ships (personal + NPC + corp-owned)
DELETE FROM ship_instances WHERE owner_character_id IN (
  '1a000000-0000-4000-8000-000000000001',
  '1a100000-0000-4000-8000-000000000001',
  '1a200000-0000-4000-8000-000000000001',
  '1a300000-0000-4000-8000-000000000001',
  '1a400000-0000-4000-8000-000000000001'
);
DELETE FROM ship_instances WHERE owner_corporation_id IN (
  '1a000000-0000-4000-8000-c00000000001',
  '1a000000-0000-4000-8000-c00000000002'
);

-- 6. Corporations (founder FK means characters must stay until after this)
DELETE FROM corporations WHERE corp_id IN (
  '1a000000-0000-4000-8000-c00000000001',
  '1a000000-0000-4000-8000-c00000000002'
);

-- 7a. Parallel-clone teardown (slots 002..016). Clones are seeded later
-- via a DO block; clean up any that exist before nulling FKs / dropping
-- characters so re-runs are idempotent.
DO $clone_teardown$
DECLARE
  i           INT;
  v_char_id   UUID;
  v_ship_id   UUID;
BEGIN
  FOR i IN 2..16 LOOP
    v_char_id := ('1a000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid;
    v_ship_id := ('1a000000-0000-4000-8000-5a8369' || lpad(i::text, 6, '0'))::uuid;
    DELETE FROM user_characters WHERE character_id = v_char_id;
    DELETE FROM events WHERE character_id = v_char_id OR sender_id = v_char_id OR ship_id = v_ship_id;
    DELETE FROM corporation_members WHERE character_id = v_char_id;
    UPDATE characters SET current_ship_id = NULL, corporation_id = NULL WHERE character_id = v_char_id;
    DELETE FROM ship_instances WHERE ship_id = v_ship_id;
    DELETE FROM characters WHERE character_id = v_char_id;
  END LOOP;
END $clone_teardown$;

-- 7b. Characters (the 5 main Orion Vale world characters)
DELETE FROM characters WHERE character_id IN (
  '1a000000-0000-4000-8000-000000000001',
  '1a100000-0000-4000-8000-000000000001',
  '1a200000-0000-4000-8000-000000000001',
  '1a300000-0000-4000-8000-000000000001',
  '1a400000-0000-4000-8000-000000000001'
);

-- 8. Universe-scoped rows. universe_structure is shared with the base 5000-
-- sector universe, so we UPSERT it below rather than deleting. For ports, we
-- only clear out the mega-port we own at sector 305 (other ports in our 9
-- sectors belong to the base universe and we leave them alone). sector_contents
-- gets fully cleared for our 9 sectors because we re-link it below.
DELETE FROM sector_contents WHERE sector_id IN (305, 1704, 2880, 3149, 3150, 3786, 4200, 4202, 4867);
DELETE FROM ports WHERE sector_id = 305;

-- ── SEED: UNIVERSE ────────────────────────────────────────────────────

-- universe_config is a singleton (id=1). Merge 305 into fedspace/mega-port
-- arrays rather than clobbering, so other tests' sectors stay registered.
INSERT INTO universe_config (id, sector_count, generation_seed, generation_params, meta)
VALUES (
  1, 5000, 99999,
  '{"source": "orion-vale-eval-seed"}'::jsonb,
  '{"source": "orion-vale-eval-seed", "fedspace_sectors": [305], "mega_port_sectors": [305]}'::jsonb
)
ON CONFLICT (id) DO UPDATE
SET meta = jsonb_set(
  jsonb_set(
    COALESCE(universe_config.meta, '{}'::jsonb),
    '{fedspace_sectors}',
    CASE
      WHEN universe_config.meta->'fedspace_sectors' @> '[305]'::jsonb
        THEN universe_config.meta->'fedspace_sectors'
      ELSE COALESCE(universe_config.meta->'fedspace_sectors', '[]'::jsonb) || '[305]'::jsonb
    END
  ),
  '{mega_port_sectors}',
  CASE
    WHEN universe_config.meta->'mega_port_sectors' @> '[305]'::jsonb
      THEN universe_config.meta->'mega_port_sectors'
    ELSE COALESCE(universe_config.meta->'mega_port_sectors', '[]'::jsonb) || '[305]'::jsonb
  END
);

-- Sectors: two reachable corridors
--   Corridor A: 3150 → 3149 → 2880 → 4202 → 4867 (Orion's start to destination)
--   Bridge:    3150 → 3786 → 305 (border sector → mega-port in fedspace)
--   Corridor B: 305 → 4200 → 1704 (mega-port → corp ship at 1704)
INSERT INTO universe_structure (sector_id, position_x, position_y, region, warps) VALUES
  (3150, 0, 0, 'neutral',  '[{"to": 3149, "two_way": true}, {"to": 3786, "two_way": true}]'::jsonb),
  (3149, 1, 0, 'neutral',  '[{"to": 3150, "two_way": true}, {"to": 2880, "two_way": true}]'::jsonb),
  (2880, 2, 0, 'neutral',  '[{"to": 3149, "two_way": true}, {"to": 4202, "two_way": true}]'::jsonb),
  (4202, 3, 0, 'neutral',  '[{"to": 2880, "two_way": true}, {"to": 4867, "two_way": true}]'::jsonb),
  (4867, 4, 0, 'neutral',  '[{"to": 4202, "two_way": true}]'::jsonb),
  (3786, 0, 1, 'neutral',  '[{"to": 3150, "two_way": true}, {"to": 305,  "two_way": true}]'::jsonb),
  (305,  0, 2, 'fedspace', '[{"to": 3786, "two_way": true}, {"to": 4200, "two_way": true}]'::jsonb),
  (4200, 1, 2, 'neutral',  '[{"to": 305,  "two_way": true}, {"to": 1704, "two_way": true}]'::jsonb),
  (1704, 2, 2, 'neutral',  '[{"to": 4200, "two_way": true}]'::jsonb)
ON CONFLICT (sector_id) DO UPDATE
SET position_x = EXCLUDED.position_x,
    position_y = EXCLUDED.position_y,
    region     = EXCLUDED.region,
    warps      = EXCLUDED.warps;

-- Mega-port at sector 305 — port code BBS (buy QF, buy RO, sell NS).
-- Orion Vale's commodity sales/purchases will hit this port.
WITH inserted_port AS (
  INSERT INTO ports (sector_id, port_code, port_class, max_qf, max_ro, max_ns, stock_qf, stock_ro, stock_ns)
  VALUES (305, 'BBS', 1, 1000, 1000, 1000, 300, 300, 700)
  RETURNING port_id, sector_id
)
-- Sector contents: link the mega-port to sector 305; empty for the other 8.
INSERT INTO sector_contents (sector_id, port_id, combat, salvage)
SELECT s.sid, p.port_id, NULL, '[]'::jsonb
FROM (VALUES (305), (1704), (2880), (3149), (3150), (3786), (4200), (4202), (4867)) AS s(sid)
LEFT JOIN inserted_port p ON p.sector_id = s.sid;

-- ── SEED: CHARACTERS ──────────────────────────────────────────────────

-- Map knowledge: all 9 sectors known to every main player so plot_course and
-- list_known_ports return data without triggering "explore unknown" branches.
-- Drifter (NPC) gets map_knowledge covering just its own sector.

-- Orion Vale — the commander. 12k in megabank → affordability scenarios that
-- exercise the bank pool. current_sector and credits_on_hand live on her ship.
INSERT INTO characters (character_id, name, credits_in_megabank, map_knowledge, player_metadata)
VALUES (
  '1a000000-0000-4000-8000-000000000001',
  'Orion Vale Eval',
  12000,
  '{
    "total_sectors_visited": 9,
    "sectors_visited": {
      "305":  {"adjacent_sectors": [3786, 4200], "last_visited": "2026-04-13T00:00:00Z", "position": [0, 2]},
      "1704": {"adjacent_sectors": [4200],       "last_visited": "2026-04-13T00:00:00Z", "position": [2, 2]},
      "2880": {"adjacent_sectors": [3149, 4202], "last_visited": "2026-04-13T00:00:00Z", "position": [2, 0]},
      "3149": {"adjacent_sectors": [3150, 2880], "last_visited": "2026-04-13T00:00:00Z", "position": [1, 0]},
      "3150": {"adjacent_sectors": [3149, 3786], "last_visited": "2026-04-13T00:00:00Z", "position": [0, 0]},
      "3786": {"adjacent_sectors": [3150, 305],  "last_visited": "2026-04-13T00:00:00Z", "position": [0, 1]},
      "4200": {"adjacent_sectors": [305, 1704],  "last_visited": "2026-04-13T00:00:00Z", "position": [1, 2]},
      "4202": {"adjacent_sectors": [2880, 4867], "last_visited": "2026-04-13T00:00:00Z", "position": [3, 0]},
      "4867": {"adjacent_sectors": [4202],       "last_visited": "2026-04-13T00:00:00Z", "position": [4, 0]}
    }
  }'::jsonb,
  '{"source": "orion-vale-eval-seed", "role": "commander"}'::jsonb
);

-- Starfall — passive peer at the mega-port. Exists so scenario 10 ("is Starfall
-- online?") has a valid referent.
INSERT INTO characters (character_id, name, credits_in_megabank, map_knowledge, player_metadata)
VALUES (
  '1a100000-0000-4000-8000-000000000001',
  'Starfall Eval',
  0,
  '{"total_sectors_visited": 1, "sectors_visited": {"305": {"adjacent_sectors": [3786, 4200], "last_visited": "2026-04-13T00:00:00Z", "position": [0, 2]}}}'::jsonb,
  '{"source": "orion-vale-eval-seed", "role": "passive-peer"}'::jsonb
);

-- Drifter — hostile NPC sharing Orion's sector. Enables combat scenarios.
INSERT INTO characters (character_id, name, credits_in_megabank, is_npc, map_knowledge, player_metadata)
VALUES (
  '1a200000-0000-4000-8000-000000000001',
  'Drifter Eval',
  0,
  TRUE,
  '{"total_sectors_visited": 1, "sectors_visited": {"3150": {"adjacent_sectors": [3149, 3786], "last_visited": "2026-04-13T00:00:00Z", "position": [0, 0]}}}'::jsonb,
  '{"source": "orion-vale-eval-seed", "role": "hostile-npc"}'::jsonb
);

-- Nova Prime — founder of Stellar Traders. Higher bank balance than Orion so
-- leaderboard-by-wealth scenarios have a distinguishable top player.
INSERT INTO characters (character_id, name, credits_in_megabank, map_knowledge, player_metadata)
VALUES (
  '1a300000-0000-4000-8000-000000000001',
  'Nova Prime Eval',
  85000,
  '{"total_sectors_visited": 1, "sectors_visited": {"305": {"adjacent_sectors": [3786, 4200], "last_visited": "2026-04-13T00:00:00Z", "position": [0, 2]}}}'::jsonb,
  '{"source": "orion-vale-eval-seed", "role": "other-corp-founder"}'::jsonb
);

-- Moonshadow — second Night Wardens member. Target for kick-corp-member scenarios.
INSERT INTO characters (character_id, name, credits_in_megabank, map_knowledge, player_metadata)
VALUES (
  '1a400000-0000-4000-8000-000000000001',
  'Moonshadow Eval',
  2000,
  '{"total_sectors_visited": 1, "sectors_visited": {"305": {"adjacent_sectors": [3786, 4200], "last_visited": "2026-04-13T00:00:00Z", "position": [0, 2]}}}'::jsonb,
  '{"source": "orion-vale-eval-seed", "role": "corp-member-to-kick"}'::jsonb
);

-- ── SEED: CORPORATIONS ────────────────────────────────────────────────

INSERT INTO corporations (corp_id, name, founder_id, invite_code, metadata) VALUES
  ('1a000000-0000-4000-8000-c00000000001', 'Night Wardens Eval',
   '1a000000-0000-4000-8000-000000000001', 'wardens-01',
   '{"source": "orion-vale-eval-seed"}'::jsonb),
  ('1a000000-0000-4000-8000-c00000000002', 'Stellar Traders Eval',
   '1a300000-0000-4000-8000-000000000001', 'stellar-01',
   '{"source": "orion-vale-eval-seed"}'::jsonb);

-- ── SEED: SHIPS (personal + NPC) ──────────────────────────────────────

-- Orion's kestrel — 28,450 credits on hand, 320/450 warp power. These numbers
-- match the test profile on Cekura so scenario dialog aligns with DB state.
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, ship_name, current_sector, credits,
  current_warp_power, current_shields, current_fighters, metadata
) VALUES (
  '1a000000-0000-4000-8000-5a8369000001',
  '1a000000-0000-4000-8000-000000000001', 'character', '1a000000-0000-4000-8000-000000000001',
  'kestrel_courier', 'Orion Vale Kestrel', 3150, 28450,
  320, 45, 0, '{"source": "orion-vale-eval-seed"}'::jsonb
);

-- Starfall's sparrow — at the mega-port.
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, ship_name, current_sector, credits,
  current_warp_power, current_shields, current_fighters, metadata
) VALUES (
  '1a100000-0000-4000-8000-000000000002',
  '1a100000-0000-4000-8000-000000000001', 'character', '1a100000-0000-4000-8000-000000000001',
  'sparrow_scout', 'Starfall Sparrow', 305, 1000,
  200, 30, 0, '{"source": "orion-vale-eval-seed"}'::jsonb
);

-- Drifter's Rust Fang — hostile corsair with 60 fighters in Orion's sector.
-- Fighters aboard so combat_initiate has a valid encounter.
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, ship_name, current_sector, credits,
  current_warp_power, current_shields, current_fighters, metadata
) VALUES (
  '1a200000-0000-4000-8000-000000000002',
  '1a200000-0000-4000-8000-000000000001', 'character', '1a200000-0000-4000-8000-000000000001',
  'corsair_raider', 'Rust Fang', 3150, 500,
  180, 90, 60, '{"source": "orion-vale-eval-seed", "hostility": "hostile"}'::jsonb
);

-- Nova Prime's wayfarer — at mega-port.
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, ship_name, current_sector, credits,
  current_warp_power, current_shields, current_fighters, metadata
) VALUES (
  '1a300000-0000-4000-8000-000000000002',
  '1a300000-0000-4000-8000-000000000001', 'character', '1a300000-0000-4000-8000-000000000001',
  'wayfarer_freighter', 'Nova Wayfarer', 305, 45000,
  520, 80, 20, '{"source": "orion-vale-eval-seed"}'::jsonb
);

-- Moonshadow's sparrow — at mega-port, second Night Wardens member.
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_character_id,
  ship_type, ship_name, current_sector, credits,
  current_warp_power, current_shields, current_fighters, metadata
) VALUES (
  '1a400000-0000-4000-8000-000000000002',
  '1a400000-0000-4000-8000-000000000001', 'character', '1a400000-0000-4000-8000-000000000001',
  'sparrow_scout', 'Moonshadow Scout', 305, 800,
  200, 30, 0, '{"source": "orion-vale-eval-seed"}'::jsonb
);

-- ── SEED: CORP SHIPS ──────────────────────────────────────────────────

-- Coco Probe-1 — autonomous_probe at sector 4200. Short id prefix 062cb6 used
-- in scenario dialog.
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_corporation_id,
  ship_type, ship_name, current_sector, credits,
  current_warp_power, current_shields, current_fighters, metadata
) VALUES (
  '1a000000-0000-4000-8000-062cb6000001',
  '1a000000-0000-4000-8000-c00000000001', 'corporation', '1a000000-0000-4000-8000-c00000000001',
  'autonomous_probe', 'Coco Probe-1', 4200, 4800,
  600, 20, 0, '{"source": "orion-vale-eval-seed"}'::jsonb
);

-- Light Hauler Alpha — autonomous_light_hauler at sector 1704. Short id prefix
-- 0d91eb used in scenario dialog (S05: "bring Light Hauler Alpha to 305").
INSERT INTO ship_instances (
  ship_id, owner_id, owner_type, owner_corporation_id,
  ship_type, ship_name, current_sector, credits,
  current_warp_power, current_shields, current_fighters, metadata
) VALUES (
  '1a000000-0000-4000-8000-0d91eb000001',
  '1a000000-0000-4000-8000-c00000000001', 'corporation', '1a000000-0000-4000-8000-c00000000001',
  'autonomous_light_hauler', 'Light Hauler Alpha', 1704, 22000,
  450, 80, 0, '{"source": "orion-vale-eval-seed"}'::jsonb
);

-- ── SEED: CORP MEMBERSHIP + SHIP JOIN ROWS ────────────────────────────

INSERT INTO corporation_members (corp_id, character_id, joined_at) VALUES
  ('1a000000-0000-4000-8000-c00000000001', '1a000000-0000-4000-8000-000000000001', NOW()),
  ('1a000000-0000-4000-8000-c00000000001', '1a400000-0000-4000-8000-000000000001', NOW()),
  ('1a000000-0000-4000-8000-c00000000002', '1a300000-0000-4000-8000-000000000001', NOW());

INSERT INTO corporation_ships (corp_id, ship_id, added_at, added_by) VALUES
  ('1a000000-0000-4000-8000-c00000000001', '1a000000-0000-4000-8000-062cb6000001',
   NOW(), '1a000000-0000-4000-8000-000000000001'),
  ('1a000000-0000-4000-8000-c00000000001', '1a000000-0000-4000-8000-0d91eb000001',
   NOW(), '1a000000-0000-4000-8000-000000000001');

-- ── LINK CHARACTERS TO SHIPS AND CORPS ────────────────────────────────

UPDATE characters SET current_ship_id = '1a000000-0000-4000-8000-5a8369000001',
                       corporation_id = '1a000000-0000-4000-8000-c00000000001',
                       corporation_joined_at = NOW()
WHERE character_id = '1a000000-0000-4000-8000-000000000001';

UPDATE characters SET current_ship_id = '1a100000-0000-4000-8000-000000000002'
WHERE character_id = '1a100000-0000-4000-8000-000000000001';

UPDATE characters SET current_ship_id = '1a200000-0000-4000-8000-000000000002'
WHERE character_id = '1a200000-0000-4000-8000-000000000001';

UPDATE characters SET current_ship_id = '1a300000-0000-4000-8000-000000000002',
                       corporation_id = '1a000000-0000-4000-8000-c00000000002',
                       corporation_joined_at = NOW()
WHERE character_id = '1a300000-0000-4000-8000-000000000001';

UPDATE characters SET current_ship_id = '1a400000-0000-4000-8000-000000000002',
                       corporation_id = '1a000000-0000-4000-8000-c00000000001',
                       corporation_joined_at = NOW()
WHERE character_id = '1a400000-0000-4000-8000-000000000001';

-- ── HISTORICAL EVENT ──────────────────────────────────────────────────

-- One recent movement.complete event in Orion's sector so S04 (historical
-- query for "who visited sector 3150") has data to return. Timestamped 10
-- minutes ago so it's always in any reasonable event_query window.
INSERT INTO events (
  timestamp, direction, event_type, character_id, sender_id, sector_id, ship_id,
  payload, meta
) VALUES (
  NOW() - INTERVAL '10 minutes',
  'event_out', 'movement.complete',
  '1a000000-0000-4000-8000-000000000001',
  '1a000000-0000-4000-8000-000000000001',
  3150,
  '1a000000-0000-4000-8000-5a8369000001',
  '{"from": 3149, "to": 3150, "has_megaport": false, "ship_name": "Orion Vale Kestrel"}'::jsonb,
  '{"source": "orion-vale-eval-seed"}'::jsonb
);

-- ── LINK TO EVAL USER (Drifter is NPC, not linked) ────────────────────
-- Orion's world uses a dedicated auth user so it doesn't bump against the
-- 5-character cap on the shared eval user. ON CONFLICT DO NOTHING keeps
-- re-runs idempotent.

INSERT INTO auth.users (id, email, aud, role, is_sso_user, is_anonymous)
VALUES ('1a000000-1a00-4aaa-8000-000000000001', 'orion-eval@gradientbang.com',
        'authenticated', 'authenticated', false, false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_characters (user_id, character_id) VALUES
  ('1a000000-1a00-4aaa-8000-000000000001', '1a000000-0000-4000-8000-000000000001'),
  ('1a000000-1a00-4aaa-8000-000000000001', '1a100000-0000-4000-8000-000000000001'),
  ('1a000000-1a00-4aaa-8000-000000000001', '1a300000-0000-4000-8000-000000000001'),
  ('1a000000-1a00-4aaa-8000-000000000001', '1a400000-0000-4000-8000-000000000001');

-- ── PARALLEL CLONES (slots 002..016) ─────────────────────────────────
-- Each clone mirrors Orion Vale's full commander state (kestrel_courier in
-- sector 3150, 28,450 credits on hand, 12k megabank, full 9-sector map
-- knowledge, Night Wardens corp membership) on a unique character_id so
-- the Cekura platform can run up to 16 scenarios in parallel — its
-- single-run-per-character limit was forcing serialization. Slot 001
-- remains the canonical corp founder; clones are members. Each clone
-- has its own auth user to stay under the 5-character-per-user trigger.

DO $clone_seed$
DECLARE
  i            INT;
  v_char_id    UUID;
  v_ship_id    UUID;
  v_user_id    UUID;
  v_user_email TEXT;
  v_orion_map  JSONB;
BEGIN
  -- Snapshot Orion's map_knowledge so clones share the exact same world view.
  SELECT map_knowledge INTO v_orion_map
  FROM characters WHERE character_id = '1a000000-0000-4000-8000-000000000001';

  FOR i IN 2..16 LOOP
    v_char_id    := ('1a000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid;
    v_ship_id    := ('1a000000-0000-4000-8000-5a8369' || lpad(i::text, 6, '0'))::uuid;
    v_user_id    := ('1a000000-1a00-4aaa-8000-' || lpad(i::text, 12, '0'))::uuid;
    v_user_email := 'orion-eval-' || lpad(i::text, 2, '0') || '@gradientbang.com';

    INSERT INTO auth.users (id, email, aud, role, is_sso_user, is_anonymous)
    VALUES (v_user_id, v_user_email, 'authenticated', 'authenticated', false, false)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO characters (character_id, name, credits_in_megabank, map_knowledge, player_metadata)
    VALUES (
      v_char_id,
      'Orion Vale Eval ' || lpad(i::text, 2, '0'),
      12000,
      v_orion_map,
      jsonb_build_object('source', 'orion-vale-eval-seed', 'role', 'parallel-clone', 'slot', i)
    );

    INSERT INTO ship_instances (
      ship_id, owner_id, owner_type, owner_character_id,
      ship_type, ship_name, current_sector, credits,
      current_warp_power, current_shields, current_fighters, metadata
    ) VALUES (
      v_ship_id, v_char_id, 'character', v_char_id,
      'kestrel_courier',
      'Orion Vale Kestrel ' || lpad(i::text, 2, '0'),
      3150, 28450, 320, 45, 0,
      jsonb_build_object('source', 'orion-vale-eval-seed', 'clone_slot', i)
    );

    UPDATE characters SET
      current_ship_id = v_ship_id,
      corporation_id = '1a000000-0000-4000-8000-c00000000001',
      corporation_joined_at = NOW()
    WHERE character_id = v_char_id;

    INSERT INTO corporation_members (corp_id, character_id, joined_at)
    VALUES ('1a000000-0000-4000-8000-c00000000001', v_char_id, NOW());

    INSERT INTO user_characters (user_id, character_id) VALUES (v_user_id, v_char_id);
  END LOOP;
END $clone_seed$;

COMMIT;
