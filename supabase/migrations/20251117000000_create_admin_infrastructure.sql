-- Admin Infrastructure for Admin Edge Functions
-- Created: 2025-11-17
-- Purpose: Admin audit logging, leaderboard caching, port operations

-- ============================================================================
-- Admin Actions Audit Table
-- ============================================================================

CREATE TABLE admin_actions (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  admin_user TEXT NOT NULL DEFAULT 'admin',
  target_id UUID,
  payload JSONB,
  result TEXT NOT NULL CHECK (result IN ('success', 'error')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_admin_actions_created_at ON admin_actions (created_at DESC);
CREATE INDEX idx_admin_actions_action ON admin_actions (action);
CREATE INDEX idx_admin_actions_target_id ON admin_actions (target_id) WHERE target_id IS NOT NULL;

COMMENT ON TABLE admin_actions IS 'Audit log for all admin operations';
COMMENT ON COLUMN admin_actions.action IS 'Admin operation type (character_create, reset_ports, etc.)';
COMMENT ON COLUMN admin_actions.target_id IS 'Character ID or other target entity affected by operation';
COMMENT ON COLUMN admin_actions.payload IS 'Full request payload (for forensics)';
COMMENT ON COLUMN admin_actions.result IS 'Operation result: success or error';

-- ============================================================================
-- Leaderboard Cache Table
-- ============================================================================

CREATE TABLE leaderboard_cache (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- Singleton
  wealth JSONB NOT NULL DEFAULT '[]'::jsonb,
  territory JSONB NOT NULL DEFAULT '[]'::jsonb,
  trading JSONB NOT NULL DEFAULT '[]'::jsonb,
  exploration JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE leaderboard_cache IS 'Cached leaderboard data (singleton, 5-minute TTL)';

-- Insert initial empty cache
INSERT INTO leaderboard_cache (id, wealth, territory, trading, exploration)
VALUES (1, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);

-- ============================================================================
-- Stored Procedure: reset_all_ports()
-- ============================================================================

CREATE OR REPLACE FUNCTION reset_all_ports()
RETURNS INTEGER AS $$
DECLARE
  reset_count INTEGER := 0;
  initial_states JSONB;
  port_record RECORD;
  initial_state JSONB;
BEGIN
  -- Load initial states from universe_config
  SELECT generation_params->'initial_port_states' INTO initial_states
  FROM universe_config WHERE id = 1;

  IF initial_states IS NULL THEN
    RAISE EXCEPTION 'No initial port states found in universe_config.generation_params.initial_port_states';
  END IF;

  -- Reset each port to initial stock levels
  FOR port_record IN SELECT port_id, sector_id FROM ports LOOP
    initial_state := initial_states->port_record.sector_id::text;

    IF initial_state IS NULL THEN
      RAISE WARNING 'No initial state for port in sector %', port_record.sector_id;
      CONTINUE;
    END IF;

    UPDATE ports SET
      stock_qf = COALESCE((initial_state->>'stock_qf')::INTEGER, 0),
      stock_ro = COALESCE((initial_state->>'stock_ro')::INTEGER, 0),
      stock_ns = COALESCE((initial_state->>'stock_ns')::INTEGER, 0),
      version = version + 1,
      last_updated = NOW()
    WHERE port_id = port_record.port_id;

    reset_count := reset_count + 1;
  END LOOP;

  RETURN reset_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION reset_all_ports() IS 'Reset all ports to initial stock levels from universe_config';

-- ============================================================================
-- Stored Procedure: regenerate_ports(fraction)
-- ============================================================================

CREATE OR REPLACE FUNCTION regenerate_ports(fraction FLOAT DEFAULT 0.25)
RETURNS INTEGER AS $$
DECLARE
  regen_count INTEGER := 0;
  port_record RECORD;
  regen_amount INTEGER;
BEGIN
  IF fraction < 0.0 OR fraction > 1.0 THEN
    RAISE EXCEPTION 'Fraction must be between 0.0 and 1.0, got %', fraction;
  END IF;

  FOR port_record IN SELECT * FROM ports LOOP
    -- Quantum Foam (port_code[1])
    IF SUBSTRING(port_record.port_code, 1, 1) = 'S' THEN
      -- SELL port: increase stock toward max
      regen_amount := FLOOR(port_record.max_qf * fraction);
      UPDATE ports SET stock_qf = LEAST(max_qf, stock_qf + regen_amount)
      WHERE port_id = port_record.port_id;
    ELSIF SUBSTRING(port_record.port_code, 1, 1) = 'B' THEN
      -- BUY port: decrease stock (increase buying capacity)
      regen_amount := FLOOR(port_record.max_qf * fraction);
      UPDATE ports SET stock_qf = GREATEST(0, stock_qf - regen_amount)
      WHERE port_id = port_record.port_id;
    END IF;

    -- Retro Organics (port_code[2])
    IF SUBSTRING(port_record.port_code, 2, 1) = 'S' THEN
      regen_amount := FLOOR(port_record.max_ro * fraction);
      UPDATE ports SET stock_ro = LEAST(max_ro, stock_ro + regen_amount)
      WHERE port_id = port_record.port_id;
    ELSIF SUBSTRING(port_record.port_code, 2, 1) = 'B' THEN
      regen_amount := FLOOR(port_record.max_ro * fraction);
      UPDATE ports SET stock_ro = GREATEST(0, stock_ro - regen_amount)
      WHERE port_id = port_record.port_id;
    END IF;

    -- Neuro Symbolics (port_code[3])
    IF SUBSTRING(port_record.port_code, 3, 1) = 'S' THEN
      regen_amount := FLOOR(port_record.max_ns * fraction);
      UPDATE ports SET stock_ns = LEAST(max_ns, stock_ns + regen_amount)
      WHERE port_id = port_record.port_id;
    ELSIF SUBSTRING(port_record.port_code, 3, 1) = 'B' THEN
      regen_amount := FLOOR(port_record.max_ns * fraction);
      UPDATE ports SET stock_ns = GREATEST(0, stock_ns - regen_amount)
      WHERE port_id = port_record.port_id;
    END IF;

    -- Increment version for optimistic locking
    UPDATE ports SET version = version + 1, last_updated = NOW()
    WHERE port_id = port_record.port_id;

    regen_count := regen_count + 1;
  END LOOP;

  RETURN regen_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION regenerate_ports(FLOAT) IS 'Partially regenerate port inventories by fraction of max capacity (default 25%)';

-- ============================================================================
-- RPC Helper: refresh_materialized_view(view_name)
-- ============================================================================

CREATE OR REPLACE FUNCTION refresh_materialized_view(view_name TEXT)
RETURNS VOID AS $$
BEGIN
  EXECUTE format('REFRESH MATERIALIZED VIEW %I', view_name);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION refresh_materialized_view(TEXT) IS 'Refresh a materialized view by name (security definer for edge functions)';
