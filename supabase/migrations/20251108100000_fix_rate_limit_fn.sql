-- Fix ambiguous window_start reference in rate limit function
CREATE OR REPLACE FUNCTION check_and_increment_rate_limit(
  p_character_id UUID,
  p_endpoint TEXT,
  p_max_requests INTEGER,
  p_window_seconds INTEGER DEFAULT 60
) RETURNS BOOLEAN AS $$
DECLARE
  window_start_ts TIMESTAMPTZ;
  current_count INTEGER;
BEGIN
  window_start_ts := date_trunc('minute', NOW()) -
    (EXTRACT(EPOCH FROM date_trunc('minute', NOW()))::INTEGER % p_window_seconds) * INTERVAL '1 second';

  INSERT INTO rate_limits (character_id, endpoint, window_start, request_count)
  VALUES (p_character_id, p_endpoint, window_start_ts, 1)
  ON CONFLICT (character_id, endpoint, window_start)
  DO UPDATE SET request_count = rate_limits.request_count + 1
  RETURNING request_count INTO current_count;

  RETURN current_count <= p_max_requests;
END;
$$ LANGUAGE plpgsql;
