-- Add explicit purchase_price column for ship definitions and sync stats with game-server/ships.py

ALTER TABLE ship_definitions
  ADD COLUMN IF NOT EXISTS purchase_price INTEGER NOT NULL DEFAULT 0;

-- Remove deprecated placeholder ship types so we can rely on the canonical registry
DELETE FROM ship_definitions
WHERE ship_type IN ('atlas_freighter', 'falcon_interceptor');

WITH ship_data AS (
  SELECT * FROM (VALUES
    ('kestrel_courier', 'Kestrel Courier', 30, 300, 3, 150, 300, 25000, 25000,
      jsonb_build_object('role', 'starter', 'trade_in_value', 15000, 'equipment_slots', 2, 'built_in_features', jsonb_build_array())),
    ('sparrow_scout', 'Sparrow Scout', 20, 280, 2, 120, 200, 35000, 35000,
      jsonb_build_object('role', 'recon', 'trade_in_value', 21000, 'equipment_slots', 2, 'built_in_features', jsonb_build_array('scanner'))),
    ('wayfarer_freighter', 'Wayfarer Freighter', 120, 800, 3, 300, 600, 120000, 120000,
      jsonb_build_object('role', 'main trader', 'trade_in_value', 72000, 'equipment_slots', 3, 'built_in_features', jsonb_build_array())),
    ('atlas_hauler', 'Atlas Hauler', 300, 1600, 4, 250, 500, 260000, 260000,
      jsonb_build_object('role', 'bulk cargo', 'trade_in_value', 156000, 'equipment_slots', 3, 'built_in_features', jsonb_build_array())),
    ('pioneer_lifter', 'Pioneer Lifter', 180, 1400, 4, 200, 500, 220000, 220000,
      jsonb_build_object('role', 'logistics', 'trade_in_value', 132000, 'equipment_slots', 3, 'built_in_features', jsonb_build_array())),
    ('corsair_raider', 'Corsair Raider', 60, 700, 3, 400, 1500, 180000, 180000,
      jsonb_build_object('role', 'pirate', 'trade_in_value', 108000, 'equipment_slots', 3, 'built_in_features', jsonb_build_array())),
    ('pike_frigate', 'Pike Frigate', 70, 900, 3, 600, 2000, 300000, 300000,
      jsonb_build_object('role', 'assault', 'trade_in_value', 180000, 'equipment_slots', 3, 'built_in_features', jsonb_build_array())),
    ('bulwark_destroyer', 'Bulwark Destroyer', 80, 1500, 4, 1200, 4000, 450000, 450000,
      jsonb_build_object('role', 'line combat', 'trade_in_value', 270000, 'equipment_slots', 3, 'built_in_features', jsonb_build_array())),
    ('aegis_cruiser', 'Aegis Cruiser', 90, 1300, 3, 1000, 3500, 700000, 700000,
      jsonb_build_object('role', 'control/escort', 'trade_in_value', 420000, 'equipment_slots', 4, 'built_in_features', jsonb_build_array())),
    ('sovereign_starcruiser', 'Sovereign Starcruiser', 140, 3000, 3, 2000, 6500, 2500000, 2500000,
      jsonb_build_object('role', 'flagship', 'trade_in_value', 1500000, 'equipment_slots', 5, 'built_in_features', jsonb_build_array('transwarp'))),
    ('escape_pod', 'Escape Pod', 0, 800, 1, 0, 0, 0, 0,
      jsonb_build_object('role', 'lifeboat', 'trade_in_value', 0, 'equipment_slots', 0, 'built_in_features', jsonb_build_array('indestructible'))),
    ('autonomous_probe', 'Autonomous Probe', 0, 500, 1, 0, 10, 1000, 1000,
      jsonb_build_object('role', 'autonomous', 'trade_in_value', 0, 'equipment_slots', 0, 'built_in_features', jsonb_build_array())),
    ('autonomous_light_hauler', 'Autonomous Light Hauler', 20, 500, 5, 0, 10, 5000, 5000,
      jsonb_build_object('role', 'autonomous', 'trade_in_value', 0, 'equipment_slots', 0, 'built_in_features', jsonb_build_array()))
  ) AS v(ship_type, display_name, cargo_holds, warp_power_capacity, turns_per_warp, shields, fighters, base_value, purchase_price, stats)
)
INSERT INTO ship_definitions (
  ship_type,
  display_name,
  cargo_holds,
  warp_power_capacity,
  turns_per_warp,
  shields,
  fighters,
  base_value,
  purchase_price,
  stats
)
SELECT
  ship_type,
  display_name,
  cargo_holds,
  warp_power_capacity,
  turns_per_warp,
  shields,
  fighters,
  base_value,
  purchase_price,
  stats
FROM ship_data
ON CONFLICT (ship_type) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  cargo_holds = EXCLUDED.cargo_holds,
  warp_power_capacity = EXCLUDED.warp_power_capacity,
  turns_per_warp = EXCLUDED.turns_per_warp,
  shields = EXCLUDED.shields,
  fighters = EXCLUDED.fighters,
  base_value = EXCLUDED.base_value,
  purchase_price = EXCLUDED.purchase_price,
  stats = EXCLUDED.stats;

-- Ensure sample ships reference valid ship types after the cleanup
UPDATE ship_instances
SET ship_type = 'kestrel_courier'
WHERE ship_type NOT IN (
  SELECT ship_type FROM ship_definitions
);
