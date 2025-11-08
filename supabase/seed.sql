BEGIN;

TRUNCATE TABLE
  port_transactions,
  events,
  rate_limits,
  garrisons,
  sector_contents,
  ports,
  ship_instances,
  characters,
  universe_structure,
  universe_config
  RESTART IDENTITY CASCADE;

INSERT INTO universe_config (id, sector_count, generation_seed, generation_params, meta)
VALUES (
  1,
  16,
  123456789,
  jsonb_build_object('universe', 'supabase_dev'),
  jsonb_build_object('notes', 'Local developer universe seed v1')
);

INSERT INTO universe_structure (sector_id, position_x, position_y, region, warps)
VALUES
  (0, 0, 0, 'core', '[{"to":1,"two_way":true},{"to":5,"two_way":true}]'::jsonb),
  (1, 10, 0, 'core', '[{"to":0,"two_way":true},{"to":2,"two_way":true}]'::jsonb),
  (2, 20, 0, 'rim',  '[{"to":1,"two_way":true},{"to":3,"two_way":true}]'::jsonb),
  (3, 30, -5, 'rim', '[{"to":2,"two_way":true}]'::jsonb),
  (4, -10, 5, 'core', '[{"to":0,"two_way":true}]'::jsonb),
  (5, 0, 10, 'spire','[{"to":0,"two_way":true},{"to":6,"two_way":true}]'::jsonb),
  (6, 5, 18, 'spire','[{"to":5,"two_way":true}]'::jsonb);

INSERT INTO ports (
  sector_id, port_code, port_class,
  max_qf, max_ro, max_ns,
  stock_qf, stock_ro, stock_ns
) VALUES
  (0, 'BSS', 4, 400, 250, 250, 200, 150, 125),
  (2, 'SBB', 5, 500, 500, 400, 250, 225, 200),
  (5, 'BSB', 3, 350, 300, 200, 175, 110, 80);

INSERT INTO sector_contents (sector_id, port_id, combat, salvage)
SELECT sector_id, port_id, NULL, '[]'::jsonb
FROM ports;

INSERT INTO characters (
  character_id, name, current_ship_id,
  credits_in_megabank, map_knowledge,
  player_metadata, is_npc,
  created_at, last_active, first_visit
) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Aurora-Test', NULL, 25000,
   jsonb_build_object('total_sectors_visited', 4), '{}', false, NOW(), NOW(), NOW()),
  ('00000000-0000-0000-0000-000000000002', 'Borealis-NPC', NULL, 5000,
   jsonb_build_object('total_sectors_visited', 2), '{}', true, NOW(), NOW(), NOW());

INSERT INTO ship_instances (
  ship_id, owner_id, ship_type, ship_name,
  current_sector, in_hyperspace, hyperspace_destination, hyperspace_eta,
  credits, cargo_qf, cargo_ro, cargo_ns,
  current_warp_power, current_shields, current_fighters,
  metadata, is_escape_pod
) VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
   'kestrel_courier', 'Aurora Prime',
   0, false, NULL, NULL,
   15000, 10, 0, 0,
   250, 150, 280,
   jsonb_build_object('notes', 'Dev seed ship'), false),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002',
   'sparrow_scout', 'NPC Scout',
   5, false, NULL, NULL,
   8000, 0, 10, 5,
   180, 120, 200,
   jsonb_build_object('notes', 'NPC patrol ship'), false);

UPDATE characters SET current_ship_id = '10000000-0000-0000-0000-000000000001'
WHERE character_id = '00000000-0000-0000-0000-000000000001';

UPDATE characters SET current_ship_id = '10000000-0000-0000-0000-000000000002'
WHERE character_id = '00000000-0000-0000-0000-000000000002';

INSERT INTO garrisons (sector_id, owner_id, fighters, mode, toll_amount, toll_balance)
VALUES
  (2, '00000000-0000-0000-0000-000000000001', 120, 'defensive', 0, 0),
  (5, '00000000-0000-0000-0000-000000000002', 60, 'toll', 25, 1000);

COMMIT;
