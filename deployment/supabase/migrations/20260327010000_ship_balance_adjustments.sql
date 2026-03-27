-- Balance adjustments: Pioneer price drop, Corsair agility buff, Aegis fighters buff.

-- Pioneer Lifter: 220k -> 160k (was overpriced relative to Atlas at 260k)
UPDATE ship_definitions
SET
  base_value = 160000,
  purchase_price = 160000,
  stats = jsonb_set(stats, '{trade_in_value}', '96000')
WHERE ship_type = 'pioneer_lifter';

-- Corsair Raider: agility 3 -> 2 (fast hit-and-run identity)
UPDATE ship_definitions
SET turns_per_warp = 2
WHERE ship_type = 'corsair_raider';

-- Aegis Cruiser: fighters 3500 -> 4000 (justifies price premium over Bulwark as "fast Bulwark")
UPDATE ship_definitions
SET fighters = 4000
WHERE ship_type = 'aegis_cruiser';
