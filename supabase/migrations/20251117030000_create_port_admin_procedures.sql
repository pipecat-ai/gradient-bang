-- Port Admin Stored Procedures
-- Created: 2025-11-17
-- Purpose: Stored procedures for reset_ports and regenerate_ports admin functions

-- ============================================================================
-- reset_all_ports: Reset all ports to initial state from universe_config
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
    RAISE EXCEPTION 'No initial port states found in universe_config';
  END IF;

  -- Reset each port to initial stock levels
  FOR port_record IN SELECT port_id, sector_id FROM ports LOOP
    initial_state := initial_states->port_record.sector_id::text;

    IF initial_state IS NULL THEN
      -- Skip ports without initial state data
      CONTINUE;
    END IF;

    UPDATE ports SET
      stock_qf = (initial_state->>'stock_qf')::INTEGER,
      stock_ro = (initial_state->>'stock_ro')::INTEGER,
      stock_ns = (initial_state->>'stock_ns')::INTEGER,
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
-- regenerate_ports: Regenerate port stock by a fraction of max capacity
-- ============================================================================

CREATE OR REPLACE FUNCTION regenerate_ports(fraction FLOAT DEFAULT 0.25)
RETURNS INTEGER AS $$
DECLARE
  regen_count INTEGER := 0;
  port_record RECORD;
  regen_amount_qf INTEGER;
  regen_amount_ro INTEGER;
  regen_amount_ns INTEGER;
BEGIN
  IF fraction < 0.0 OR fraction > 1.0 THEN
    RAISE EXCEPTION 'Fraction must be between 0.0 and 1.0, got: %', fraction;
  END IF;

  FOR port_record IN SELECT * FROM ports LOOP
    -- Quantum Foam (index 1 in port_code)
    IF SUBSTRING(port_record.port_code, 1, 1) = 'S' THEN
      -- SELL port: increase stock toward max
      regen_amount_qf := FLOOR(port_record.max_qf * fraction);
      UPDATE ports
      SET stock_qf = LEAST(max_qf, stock_qf + regen_amount_qf),
          version = version + 1,
          last_updated = NOW()
      WHERE port_id = port_record.port_id;
    ELSIF SUBSTRING(port_record.port_code, 1, 1) = 'B' THEN
      -- BUY port: decrease stock (increase buying capacity)
      regen_amount_qf := FLOOR(port_record.max_qf * fraction);
      UPDATE ports
      SET stock_qf = GREATEST(0, stock_qf - regen_amount_qf),
          version = version + 1,
          last_updated = NOW()
      WHERE port_id = port_record.port_id;
    END IF;

    -- Retro Organics (index 2 in port_code)
    IF SUBSTRING(port_record.port_code, 2, 1) = 'S' THEN
      regen_amount_ro := FLOOR(port_record.max_ro * fraction);
      UPDATE ports
      SET stock_ro = LEAST(max_ro, stock_ro + regen_amount_ro),
          version = version + 1,
          last_updated = NOW()
      WHERE port_id = port_record.port_id;
    ELSIF SUBSTRING(port_record.port_code, 2, 1) = 'B' THEN
      regen_amount_ro := FLOOR(port_record.max_ro * fraction);
      UPDATE ports
      SET stock_ro = GREATEST(0, stock_ro - regen_amount_ro),
          version = version + 1,
          last_updated = NOW()
      WHERE port_id = port_record.port_id;
    END IF;

    -- Neuro Symbolics (index 3 in port_code)
    IF SUBSTRING(port_record.port_code, 3, 1) = 'S' THEN
      regen_amount_ns := FLOOR(port_record.max_ns * fraction);
      UPDATE ports
      SET stock_ns = LEAST(max_ns, stock_ns + regen_amount_ns),
          version = version + 1,
          last_updated = NOW()
      WHERE port_id = port_record.port_id;
    ELSIF SUBSTRING(port_record.port_code, 3, 1) = 'B' THEN
      regen_amount_ns := FLOOR(port_record.max_ns * fraction);
      UPDATE ports
      SET stock_ns = GREATEST(0, stock_ns - regen_amount_ns),
          version = version + 1,
          last_updated = NOW()
      WHERE port_id = port_record.port_id;
    END IF;

    regen_count := regen_count + 1;
  END LOOP;

  RETURN regen_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION regenerate_ports(FLOAT) IS 'Regenerate port stock by a fraction of max capacity (0.0-1.0)';
