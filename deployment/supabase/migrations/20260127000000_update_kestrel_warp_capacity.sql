-- Increase Kestrel Courier warp power capacity to 500.
-- This affects new character creation and any logic that reads ship_definitions.

UPDATE ship_definitions
SET warp_power_capacity = 500
WHERE ship_type = 'kestrel_courier';
