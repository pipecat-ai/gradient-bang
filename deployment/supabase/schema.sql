-- ============================================================================
-- Gradient Bang: Supabase Schema - Server-Only Architecture
-- Multi-ship architecture with token-protected edge functions
-- Date: 2025-10-24
-- ============================================================================
--
-- ARCHITECTURE NOTES:
-- - All requests from trusted servers (voice bot, admin CLI)
-- - Service role key authentication at infrastructure level
-- - Edge functions protected by API token (X-API-Token header)
-- - No user authentication, no RLS policies
-- - Rate limiting for defensive programming (prevent bugs/loops)
--
-- ============================================================================

-- ============================================================================
-- UNIVERSE TABLES (Static/Reference Data)
-- ============================================================================

-- Universe generation configuration and metadata (singleton table)
CREATE TABLE universe_config (
  id INTEGER PRIMARY KEY DEFAULT 1,
  sector_count INTEGER NOT NULL,
  generation_seed BIGINT,
  generation_params JSONB,           -- Full generation parameters from universe-bang
  meta JSONB,                         -- Metadata from universe_structure.json
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (id = 1)                      -- Ensure only one configuration row exists
);

COMMENT ON TABLE universe_config IS 'Universe generation configuration (singleton)';

-- Static universe structure (never modified after generation)
CREATE TABLE universe_structure (
  sector_id INTEGER PRIMARY KEY,
  position_x INTEGER NOT NULL,
  position_y INTEGER NOT NULL,
  region TEXT,                        -- Region identifier if universe uses regions
  warps JSONB NOT NULL,               -- Array of {to, two_way, is_hyperlane}
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_universe_structure_region ON universe_structure(region);

COMMENT ON TABLE universe_structure IS 'Static sector layout and warp connections (never modified)';
COMMENT ON COLUMN universe_structure.warps IS 'Array of warp connections: [{to: sector_id, two_way: bool, is_hyperlane: bool}]';

-- Port definitions and dynamic inventory state
CREATE TABLE ports (
  port_id BIGSERIAL PRIMARY KEY,
  sector_id INTEGER NOT NULL UNIQUE REFERENCES universe_structure(sector_id),
  port_code CHAR(3) NOT NULL,         -- e.g., 'BSS' (Buy QF, Sell RO, Sell NS)
  port_class INTEGER NOT NULL,        -- Port class (1-8), used during generation

  -- Maximum capacities (static)
  max_qf INTEGER NOT NULL,
  max_ro INTEGER NOT NULL,
  max_ns INTEGER NOT NULL,

  -- Current stock levels (dynamic)
  stock_qf INTEGER NOT NULL,
  stock_ro INTEGER NOT NULL,
  stock_ns INTEGER NOT NULL,

  -- Metadata
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  version INTEGER DEFAULT 1           -- Optimistic locking for trades
);

CREATE INDEX idx_ports_sector ON ports(sector_id);
CREATE INDEX idx_ports_updated ON ports(last_updated);

COMMENT ON TABLE ports IS 'Port definitions and dynamic inventory state';
COMMENT ON COLUMN ports.version IS 'Version counter for optimistic locking during trades';

-- Dynamic sector contents
CREATE TABLE sector_contents (
  sector_id INTEGER PRIMARY KEY REFERENCES universe_structure(sector_id),
  port_id BIGINT REFERENCES ports(port_id),

  -- Combat state (transient JSONB, deleted when combat ends)
  combat JSONB,                               -- {combat_id, round_number, participants, pending_actions, ...}

  -- Salvage containers in this sector (perpetual until claimed)
  salvage JSONB DEFAULT '[]',                 -- [{salvage_id, cargo, credits, claimed, metadata}]

  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sector_contents_updated ON sector_contents(updated_at);
CREATE INDEX idx_sector_contents_port ON sector_contents(port_id) WHERE port_id IS NOT NULL;

COMMENT ON TABLE sector_contents IS 'Dynamic sector state (combat, salvage)';
COMMENT ON COLUMN sector_contents.combat IS 'Active combat encounter state (JSONB), NULL if no combat';
COMMENT ON COLUMN sector_contents.salvage IS 'Array of perpetual salvage (no expiration): [{salvage_id, cargo_qf, cargo_ro, cargo_ns, scrap, credits, claimed, metadata}]';

-- ============================================================================
-- GARRISON TABLE
-- ============================================================================

CREATE TABLE garrisons (
  sector_id INTEGER NOT NULL REFERENCES universe_structure(sector_id),
  owner_id UUID NOT NULL,             -- References characters(character_id), no FK constraint
  fighters INTEGER NOT NULL CHECK (fighters > 0),
  mode TEXT NOT NULL CHECK (mode IN ('offensive', 'defensive', 'toll')),
  toll_amount INTEGER DEFAULT 0 CHECK (toll_amount >= 0),
  toll_balance INTEGER DEFAULT 0 CHECK (toll_balance >= 0),
  deployed_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (sector_id, owner_id)   -- One garrison per character per sector
);

CREATE INDEX idx_garrisons_sector ON garrisons(sector_id);
CREATE INDEX idx_garrisons_owner ON garrisons(owner_id);

COMMENT ON TABLE garrisons IS 'Stationed fighters owned by characters';

-- ============================================================================
-- SHIP TABLES
-- ============================================================================

-- Ship type definitions (static reference data)
CREATE TABLE ship_definitions (
  ship_type TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  cargo_holds INTEGER NOT NULL,
  warp_power_capacity INTEGER NOT NULL,
  turns_per_warp INTEGER NOT NULL,
  shields INTEGER NOT NULL,
  fighters INTEGER NOT NULL,
  base_value INTEGER NOT NULL,       -- For wealth calculations
  stats JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE ship_definitions IS 'Ship type definitions (static reference data)';

-- Ship instances (multi-ship architecture)
CREATE TABLE ship_instances (
  ship_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL,             -- Character who owns this ship (no FK constraint)
  ship_type TEXT NOT NULL REFERENCES ship_definitions(ship_type),
  ship_name TEXT,

  -- Location state
  current_sector INTEGER REFERENCES universe_structure(sector_id),
  in_hyperspace BOOLEAN DEFAULT FALSE,
  hyperspace_destination INTEGER REFERENCES universe_structure(sector_id),
  hyperspace_eta TIMESTAMPTZ,

  -- Resources on this ship
  credits INTEGER DEFAULT 0 CHECK (credits >= 0),
  cargo_qf INTEGER DEFAULT 0 CHECK (cargo_qf >= 0),
  cargo_ro INTEGER DEFAULT 0 CHECK (cargo_ro >= 0),
  cargo_ns INTEGER DEFAULT 0 CHECK (cargo_ns >= 0),

  -- Ship state
  current_warp_power INTEGER NOT NULL CHECK (current_warp_power >= 0),
  current_shields INTEGER NOT NULL CHECK (current_shields >= 0),
  current_fighters INTEGER NOT NULL CHECK (current_fighters >= 0),
  equipped_modules JSONB DEFAULT '[]',

  -- Metadata
  metadata JSONB DEFAULT '{}',

  is_escape_pod BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ship_instances_owner ON ship_instances(owner_id);
CREATE INDEX idx_ship_instances_sector ON ship_instances(current_sector)
  WHERE current_sector IS NOT NULL AND in_hyperspace = FALSE;
CREATE INDEX idx_ship_instances_hyperspace ON ship_instances(in_hyperspace, hyperspace_eta)
  WHERE in_hyperspace = TRUE;

COMMENT ON TABLE ship_instances IS 'Individual ships owned by characters (multi-ship support)';
COMMENT ON COLUMN ship_instances.metadata IS 'Catch-all ship metadata (paint jobs, customization, naming history, etc.)';

-- ============================================================================
-- CHARACTERS TABLE
-- ============================================================================

CREATE TABLE characters (
  character_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,

  -- Ship residence
  current_ship_id UUID REFERENCES ship_instances(ship_id),

  -- Banking (future feature)
  credits_in_megabank INTEGER DEFAULT 0 CHECK (credits_in_megabank >= 0),

  -- Map knowledge (large JSONB, loaded entirely per character)
  map_knowledge JSONB DEFAULT '{"sectors_visited": {}, "total_sectors_visited": 0}',

  -- Player metadata
  player_metadata JSONB DEFAULT '{}',

  -- Character type
  is_npc BOOLEAN DEFAULT FALSE,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_active TIMESTAMPTZ DEFAULT NOW(),
  first_visit TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_characters_name ON characters(name);
CREATE INDEX idx_characters_ship ON characters(current_ship_id);
CREATE INDEX idx_characters_active ON characters(last_active);
CREATE INDEX idx_characters_npc ON characters(is_npc) WHERE is_npc = TRUE;

COMMENT ON TABLE characters IS 'Character identity and state';
COMMENT ON COLUMN characters.map_knowledge IS 'Full map knowledge JSONB (loaded entirely, never cross-character queries)';
COMMENT ON COLUMN characters.is_npc IS 'TRUE for AI-controlled NPCs, FALSE for human players';

-- ============================================================================
-- EVENTS TABLE
-- ============================================================================

-- All events: RPC calls received and events sent to characters
-- Events are fanned out: one row per recipient character
CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  direction TEXT NOT NULL CHECK (direction IN ('rpc_in', 'event_out')),
  event_type TEXT NOT NULL,

  -- Character this event is for
  character_id UUID REFERENCES characters(character_id),

  -- Event originator
  sender_id UUID REFERENCES characters(character_id),

  -- Event payload
  payload JSONB NOT NULL,

  -- Context
  sector_id INTEGER REFERENCES universe_structure(sector_id),
  ship_id UUID REFERENCES ship_instances(ship_id),
  request_id TEXT,

  -- Metadata
  meta JSONB
);

-- Indexes for common query patterns
CREATE INDEX idx_events_timestamp ON events(timestamp DESC);
CREATE INDEX idx_events_character ON events(character_id, timestamp DESC);
CREATE INDEX idx_events_sender ON events(sender_id, timestamp DESC);
CREATE INDEX idx_events_sector ON events(sector_id, timestamp DESC);
CREATE INDEX idx_events_type ON events(event_type, timestamp DESC);
CREATE INDEX idx_events_request ON events(request_id) WHERE request_id IS NOT NULL;

COMMENT ON TABLE events IS 'All RPC calls and events (fanned out per recipient)';

-- ============================================================================
-- RATE LIMITING TABLE
-- ============================================================================

-- Per-character rate limiting (defensive programming, not security-critical)
CREATE TABLE rate_limits (
  character_id UUID NOT NULL REFERENCES characters(character_id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (character_id, endpoint, window_start)
);

CREATE INDEX idx_rate_limits_character ON rate_limits(character_id, window_start);
CREATE INDEX idx_rate_limits_window ON rate_limits(window_start);

COMMENT ON TABLE rate_limits IS 'Rate limit tracking per character (defensive, prevents bugs/loops)';

-- ============================================================================
-- AUDIT TABLES
-- ============================================================================

-- Port transaction history
CREATE TABLE port_transactions (
  id BIGSERIAL PRIMARY KEY,
  sector_id INTEGER NOT NULL REFERENCES universe_structure(sector_id),
  port_id BIGINT NOT NULL REFERENCES ports(port_id),
  character_id UUID NOT NULL REFERENCES characters(character_id),
  ship_id UUID NOT NULL REFERENCES ship_instances(ship_id),
  commodity TEXT NOT NULL CHECK (commodity IN ('QF', 'RO', 'NS')),
  quantity INTEGER NOT NULL,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('buy', 'sell')),
  price_per_unit INTEGER NOT NULL,
  total_price INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_port_transactions_sector ON port_transactions(sector_id, created_at DESC);
CREATE INDEX idx_port_transactions_character ON port_transactions(character_id, created_at DESC);
CREATE INDEX idx_port_transactions_ship ON port_transactions(ship_id, created_at DESC);
CREATE INDEX idx_port_transactions_port ON port_transactions(port_id, created_at DESC);
CREATE INDEX idx_port_transactions_created ON port_transactions(created_at DESC);

COMMENT ON TABLE port_transactions IS 'Audit log of all port trades';

-- ============================================================================
-- CONFIGURATION TABLE
-- ============================================================================

CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE config IS 'Server configuration and settings';

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Auto-update timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_ship_instances_updated_at BEFORE UPDATE ON ship_instances
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_sector_contents_updated_at BEFORE UPDATE ON sector_contents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_config_updated_at BEFORE UPDATE ON config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_garrisons_updated_at BEFORE UPDATE ON garrisons
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Update character last_active on any modification
CREATE OR REPLACE FUNCTION update_character_last_active()
RETURNS TRIGGER AS $$
BEGIN
  NEW.last_active = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_characters_last_active BEFORE UPDATE ON characters
  FOR EACH ROW EXECUTE FUNCTION update_character_last_active();

-- ============================================================================
-- DATABASE FUNCTIONS
-- ============================================================================

-- --------------------------------------------------------------------------
-- Port Trading with Optimistic Locking
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION execute_port_trade(
  p_port_id BIGINT,
  p_sector_id INTEGER,
  p_character_id UUID,
  p_ship_id UUID,
  p_commodity TEXT,
  p_quantity INTEGER,
  p_transaction_type TEXT,
  p_price_per_unit INTEGER,
  p_expected_version INTEGER
) RETURNS JSONB AS $$
DECLARE
  current_version INTEGER;
  stock_delta INTEGER;
BEGIN
  -- Validate inputs
  IF p_commodity NOT IN ('QF', 'RO', 'NS') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_commodity');
  END IF;

  IF p_transaction_type NOT IN ('buy', 'sell') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_transaction_type');
  END IF;

  -- Get current version with row lock
  SELECT version INTO current_version
  FROM ports
  WHERE port_id = p_port_id
  FOR UPDATE;

  -- Check version matches (optimistic lock)
  IF current_version != p_expected_version THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'version_mismatch',
      'current_version', current_version
    );
  END IF;

  -- Calculate stock change
  IF p_transaction_type = 'buy' THEN
    stock_delta := -p_quantity;
  ELSE
    stock_delta := p_quantity;
  END IF;

  -- Update port state
  UPDATE ports
  SET
    stock_qf = CASE WHEN p_commodity = 'QF' THEN stock_qf + stock_delta ELSE stock_qf END,
    stock_ro = CASE WHEN p_commodity = 'RO' THEN stock_ro + stock_delta ELSE stock_ro END,
    stock_ns = CASE WHEN p_commodity = 'NS' THEN stock_ns + stock_delta ELSE stock_ns END,
    version = version + 1,
    last_updated = NOW()
  WHERE port_id = p_port_id
  RETURNING version INTO current_version;

  -- Log transaction
  INSERT INTO port_transactions (
    sector_id, port_id, character_id, ship_id,
    commodity, quantity, transaction_type,
    price_per_unit, total_price
  )
  VALUES (
    p_sector_id, p_port_id, p_character_id, p_ship_id,
    p_commodity, p_quantity, p_transaction_type,
    p_price_per_unit, p_price_per_unit * p_quantity
  );

  RETURN jsonb_build_object('success', true, 'new_version', current_version);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION execute_port_trade IS 'Execute port trade with optimistic locking';

-- --------------------------------------------------------------------------
-- Ship Resource Updates
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION update_ship_resources(
  p_ship_id UUID,
  p_credits_delta INTEGER DEFAULT 0,
  p_cargo_qf_delta INTEGER DEFAULT 0,
  p_cargo_ro_delta INTEGER DEFAULT 0,
  p_cargo_ns_delta INTEGER DEFAULT 0,
  p_warp_power_delta INTEGER DEFAULT 0,
  p_shields_delta INTEGER DEFAULT 0,
  p_fighters_delta INTEGER DEFAULT 0
) RETURNS JSONB AS $$
DECLARE
  new_credits INTEGER;
  new_cargo_qf INTEGER;
  new_cargo_ro INTEGER;
  new_cargo_ns INTEGER;
  new_warp_power INTEGER;
  new_shields INTEGER;
  new_fighters INTEGER;
BEGIN
  UPDATE ship_instances
  SET
    credits = GREATEST(0, credits + p_credits_delta),
    cargo_qf = GREATEST(0, cargo_qf + p_cargo_qf_delta),
    cargo_ro = GREATEST(0, cargo_ro + p_cargo_ro_delta),
    cargo_ns = GREATEST(0, cargo_ns + p_cargo_ns_delta),
    current_warp_power = GREATEST(0, current_warp_power + p_warp_power_delta),
    current_shields = GREATEST(0, current_shields + p_shields_delta),
    current_fighters = GREATEST(0, current_fighters + p_fighters_delta),
    updated_at = NOW()
  WHERE ship_id = p_ship_id
  RETURNING credits, cargo_qf, cargo_ro, cargo_ns, current_warp_power, current_shields, current_fighters
  INTO new_credits, new_cargo_qf, new_cargo_ro, new_cargo_ns, new_warp_power, new_shields, new_fighters;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'ship_not_found');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'credits', new_credits,
    'cargo_qf', new_cargo_qf,
    'cargo_ro', new_cargo_ro,
    'cargo_ns', new_cargo_ns,
    'warp_power', new_warp_power,
    'shields', new_shields,
    'fighters', new_fighters
  );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_ship_resources IS 'Atomically update ship resources with delta values';

-- --------------------------------------------------------------------------
-- Character Sector Awareness
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_characters_aware_of_sector(p_sector_id INTEGER)
RETURNS TABLE(character_id UUID) AS $$
BEGIN
  -- Characters with ships in this sector (not in hyperspace)
  RETURN QUERY
  SELECT DISTINCT si.owner_id
  FROM ship_instances si
  WHERE si.current_sector = p_sector_id
    AND si.in_hyperspace = FALSE;

  -- Characters with garrisons in this sector
  RETURN QUERY
  SELECT DISTINCT g.owner_id
  FROM garrisons g
  WHERE g.sector_id = p_sector_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION get_characters_aware_of_sector IS 'Returns character IDs that should receive events from this sector';

-- --------------------------------------------------------------------------
-- Rate Limiting
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION check_and_increment_rate_limit(
  p_character_id UUID,
  p_endpoint TEXT,
  p_max_requests INTEGER,
  p_window_seconds INTEGER DEFAULT 60
) RETURNS BOOLEAN AS $$
DECLARE
  window_start TIMESTAMPTZ;
  current_count INTEGER;
BEGIN
  -- Calculate current window start (round down to window boundary)
  window_start := date_trunc('minute', NOW()) -
    (EXTRACT(EPOCH FROM date_trunc('minute', NOW()))::INTEGER % p_window_seconds) * INTERVAL '1 second';

  -- Get or create rate limit entry
  INSERT INTO rate_limits (character_id, endpoint, window_start, request_count)
  VALUES (p_character_id, p_endpoint, window_start, 1)
  ON CONFLICT (character_id, endpoint, window_start)
  DO UPDATE SET request_count = rate_limits.request_count + 1
  RETURNING request_count INTO current_count;

  -- Return true if within limit
  RETURN current_count <= p_max_requests;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION check_and_increment_rate_limit IS 'Check and increment rate limit counter, returns true if within limit';

-- Cleanup old rate limit windows (call periodically)
CREATE OR REPLACE FUNCTION cleanup_rate_limits()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM rate_limits
  WHERE window_start < NOW() - INTERVAL '1 hour';

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION cleanup_rate_limits IS 'Remove rate limit entries older than 1 hour';

-- --------------------------------------------------------------------------
-- Garrison Management
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_character_garrisons(p_character_id UUID)
RETURNS TABLE(
  sector_id INTEGER,
  fighters INTEGER,
  mode TEXT,
  toll_amount INTEGER,
  toll_balance INTEGER,
  deployed_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT g.sector_id, g.fighters, g.mode, g.toll_amount, g.toll_balance, g.deployed_at
  FROM garrisons g
  WHERE g.owner_id = p_character_id
  ORDER BY g.sector_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION get_character_garrisons IS 'Get all garrisons owned by a character';

-- Collect tolls from all garrisons and transfer to character bank
CREATE OR REPLACE FUNCTION collect_garrison_tolls(p_character_id UUID)
RETURNS JSONB AS $$
DECLARE
  total_tolls INTEGER;
  garrison_count INTEGER;
BEGIN
  -- Sum all toll balances
  SELECT COALESCE(SUM(toll_balance), 0), COUNT(*)
  INTO total_tolls, garrison_count
  FROM garrisons
  WHERE owner_id = p_character_id
    AND toll_balance > 0;

  -- Transfer to character bank
  IF total_tolls > 0 THEN
    UPDATE characters
    SET credits_in_megabank = credits_in_megabank + total_tolls
    WHERE character_id = p_character_id;

    -- Reset garrison toll balances
    UPDATE garrisons
    SET toll_balance = 0
    WHERE owner_id = p_character_id
      AND toll_balance > 0;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'tolls_collected', total_tolls,
    'garrison_count', garrison_count
  );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION collect_garrison_tolls IS 'Collect all toll balances from character garrisons';

-- --------------------------------------------------------------------------
-- Character Deletion
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION delete_character_cascade(p_character_id UUID)
RETURNS JSONB AS $$
DECLARE
  ships_deleted INTEGER;
  garrisons_deleted INTEGER;
BEGIN
  -- Count ships
  SELECT COUNT(*) INTO ships_deleted
  FROM ship_instances
  WHERE owner_id = p_character_id;

  -- Count garrisons
  SELECT COUNT(*) INTO garrisons_deleted
  FROM garrisons
  WHERE owner_id = p_character_id;

  -- Delete all ships owned by character
  DELETE FROM ship_instances WHERE owner_id = p_character_id;

  -- Delete all garrisons owned by character
  DELETE FROM garrisons WHERE owner_id = p_character_id;

  -- Delete character record
  DELETE FROM characters WHERE character_id = p_character_id;

  RETURN jsonb_build_object(
    'success', true,
    'ships_deleted', ships_deleted,
    'garrisons_deleted', garrisons_deleted
  );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION delete_character_cascade IS 'Delete character and all owned ships/garrisons';

-- --------------------------------------------------------------------------
-- Ship Transfer (Phase 2)
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION transfer_ship(
  p_ship_id UUID,
  p_from_character_id UUID,
  p_to_character_id UUID
) RETURNS JSONB AS $$
BEGIN
  -- Verify ownership
  IF NOT EXISTS (
    SELECT 1 FROM ship_instances
    WHERE ship_id = p_ship_id AND owner_id = p_from_character_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_owner');
  END IF;

  -- Verify recipient exists
  IF NOT EXISTS (
    SELECT 1 FROM characters WHERE character_id = p_to_character_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'recipient_not_found');
  END IF;

  -- Transfer ownership
  UPDATE ship_instances
  SET owner_id = p_to_character_id
  WHERE ship_id = p_ship_id;

  -- Log transfer event
  INSERT INTO events (
    direction, event_type,
    character_id, sender_id,
    payload, ship_id
  ) VALUES (
    'event_out', 'ship.transferred',
    p_to_character_id, p_from_character_id,
    jsonb_build_object('ship_id', p_ship_id),
    p_ship_id
  );

  RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION transfer_ship IS 'Transfer ship ownership between characters (Phase 2 feature)';

-- ============================================================================
-- LEADERBOARD VIEWS
-- ============================================================================

-- Character total wealth
CREATE VIEW leaderboard_wealth AS
SELECT
  c.character_id,
  c.name,
  c.credits_in_megabank AS bank_credits,
  COALESCE(ship_wealth.total_ship_credits, 0) AS ship_credits,
  COALESCE(ship_wealth.total_cargo_value, 0) AS cargo_value,
  COALESCE(ship_wealth.ship_count, 0) AS ships_owned,
  COALESCE(ship_wealth.total_ship_value, 0) AS ship_value,
  (c.credits_in_megabank +
   COALESCE(ship_wealth.total_ship_credits, 0) +
   COALESCE(ship_wealth.total_cargo_value, 0) +
   COALESCE(ship_wealth.total_ship_value, 0)) AS total_wealth
FROM characters c
LEFT JOIN (
  SELECT
    si.owner_id,
    COUNT(*) AS ship_count,
    SUM(si.credits) AS total_ship_credits,
    SUM(si.cargo_qf * 100 + si.cargo_ro * 100 + si.cargo_ns * 100) AS total_cargo_value,
    SUM(sd.base_value) AS total_ship_value
  FROM ship_instances si
  JOIN ship_definitions sd ON si.ship_type = sd.ship_type
  WHERE NOT si.is_escape_pod
  GROUP BY si.owner_id
) ship_wealth ON c.character_id = ship_wealth.owner_id
ORDER BY total_wealth DESC;

-- Character territory control
CREATE VIEW leaderboard_territory AS
SELECT
  c.character_id,
  c.name,
  COUNT(DISTINCT g.sector_id) AS sectors_controlled,
  SUM(g.fighters) AS total_fighters_deployed,
  SUM(g.toll_balance) AS total_toll_collected
FROM characters c
JOIN garrisons g ON c.character_id = g.owner_id
GROUP BY c.character_id, c.name
ORDER BY sectors_controlled DESC, total_fighters_deployed DESC;

-- Character trading activity (last 7 days)
CREATE VIEW leaderboard_trading AS
SELECT
  c.character_id,
  c.name,
  COUNT(*) AS total_trades,
  SUM(pt.total_price) AS total_trade_volume,
  COUNT(DISTINCT pt.sector_id) AS ports_visited
FROM characters c
JOIN port_transactions pt ON c.character_id = pt.character_id
WHERE pt.created_at > NOW() - INTERVAL '7 days'
GROUP BY c.character_id, c.name
ORDER BY total_trade_volume DESC;

-- Character exploration
CREATE VIEW leaderboard_exploration AS
SELECT
  c.character_id,
  c.name,
  (c.map_knowledge->>'total_sectors_visited')::INTEGER AS sectors_visited,
  c.first_visit
FROM characters c
ORDER BY (c.map_knowledge->>'total_sectors_visited')::INTEGER DESC;

-- ============================================================================
-- INITIAL DATA SEED
-- ============================================================================

-- Seed ship definitions
INSERT INTO ship_definitions (ship_type, display_name, cargo_holds, warp_power_capacity, turns_per_warp, shields, fighters, base_value)
VALUES
  ('kestrel_courier', 'Kestrel Courier', 40, 300, 3, 150, 300, 50000),
  ('sparrow_scout', 'Sparrow Scout', 20, 200, 2, 100, 200, 30000),
  ('atlas_freighter', 'Atlas Freighter', 100, 400, 4, 200, 400, 100000),
  ('falcon_interceptor', 'Falcon Interceptor', 30, 250, 2, 120, 350, 60000)
ON CONFLICT (ship_type) DO NOTHING;

-- ============================================================================
-- EXAMPLE QUERIES
-- ============================================================================

-- Get character with current ship
-- SELECT c.*, s.*
-- FROM characters c
-- JOIN ship_instances s ON c.current_ship_id = s.ship_id
-- WHERE c.character_id = ?;

-- Get all ships owned by a character
-- SELECT * FROM ship_instances WHERE owner_id = ?;

-- Get sector contents (port, combat, salvage, garrisons)
-- SELECT sc.*, p.*, array_agg(g.*) as garrisons
-- FROM sector_contents sc
-- LEFT JOIN ports p ON sc.port_id = p.port_id
-- LEFT JOIN garrisons g ON sc.sector_id = g.sector_id
-- WHERE sc.sector_id = ?
-- GROUP BY sc.sector_id, p.port_id;

-- Get all characters aware of a sector
-- SELECT * FROM get_characters_aware_of_sector(?);

-- Check rate limit
-- SELECT check_and_increment_rate_limit(?, 'move', 120, 60);

-- Collect garrison tolls
-- SELECT collect_garrison_tolls(?);

-- Delete character and all owned assets
-- SELECT delete_character_cascade(?);