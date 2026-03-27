-- Add Parhelion Seeker: mid-price explorer filling the gap between Kestrel (25k) and Wayfarer (120k).
-- High agility (2 turns/warp) and good range (600 warp), modest cargo and combat stats.

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
VALUES (
  'parhelion_seeker',
  'Parhelion Seeker',
  50,
  600,
  2,
  180,
  400,
  65000,
  65000,
  jsonb_build_object(
    'role', 'explorer',
    'trade_in_value', 39000,
    'equipment_slots', 2,
    'built_in_features', jsonb_build_array()
  )
)
ON CONFLICT (ship_type) DO NOTHING;
