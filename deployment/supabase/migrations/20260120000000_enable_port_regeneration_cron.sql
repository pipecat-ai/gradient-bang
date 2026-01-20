-- ============================================================================
-- Enable Hourly Port Regeneration Worker
-- ============================================================================
-- Automatically regenerates port inventories every hour at 5% of capacity.
-- - Sell ports gain stock (toward max)
-- - Buy ports lose stock (gain buying capacity)
--
-- Uses the existing regenerate_ports(fraction) stored procedure from
-- 20251117030000_create_port_admin_procedures.sql
--
-- This enables a sustainable trading economy where depleted routes
-- gradually recover over time (full recovery from 0% to 100% in ~20 hours).
-- ============================================================================

-- Schedule the port regeneration job
-- Runs at the top of every hour using standard cron syntax
SELECT cron.schedule(
  'port-regeneration-worker',    -- Job name (must be unique)
  '0 * * * *',                   -- Every hour at minute 0
  $$SELECT regenerate_ports(0.05);$$  -- 5% regeneration
);

-- Update the comment on regenerate_ports to document cron usage
COMMENT ON FUNCTION regenerate_ports(FLOAT) IS
'Regenerate port stock by a fraction of max capacity (0.0-1.0). Called hourly by cron at 5%.';

-- ============================================================================
-- Verification Queries
-- ============================================================================
-- Check if job is scheduled:
-- SELECT * FROM cron.job WHERE jobname = 'port-regeneration-worker';
--
-- View recent job runs:
-- SELECT * FROM cron.job_run_details
-- WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'port-regeneration-worker')
-- ORDER BY start_time DESC LIMIT 10;
--
-- Manually trigger port regeneration (testing):
-- SELECT regenerate_ports(0.05);
--
-- Check port stock levels:
-- SELECT
--     port_code,
--     AVG(CASE WHEN SUBSTRING(port_code,1,1)='S' THEN stock_qf::float/max_qf END) as sell_qf_fill,
--     AVG(CASE WHEN SUBSTRING(port_code,1,1)='B' THEN stock_qf::float/max_qf END) as buy_qf_fill
-- FROM ports
-- GROUP BY port_code;
-- ============================================================================
