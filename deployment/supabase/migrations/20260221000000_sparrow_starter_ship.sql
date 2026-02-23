-- Make Sparrow Scout the starter ship: lower price, remove built-in features,
-- set warp fuel to 450, and update default ship type in character creation.

-- Update sparrow_scout to starter role
UPDATE ship_definitions
SET
  purchase_price = 20000,
  base_value = 20000,
  warp_power_capacity = 450,
  stats = jsonb_set(
    jsonb_set(
      jsonb_set(stats, '{trade_in_value}', '10000'),
      '{built_in_features}', '[]'
    ),
    '{role}', '"starter"'
  )
WHERE ship_type = 'sparrow_scout';

-- Update kestrel_courier to scout role
UPDATE ship_definitions
SET
  stats = jsonb_set(stats, '{role}', '"scout"')
WHERE ship_type = 'kestrel_courier';
