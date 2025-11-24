-- ============================================================================
-- Add User Authentication Support
-- Links characters to Supabase auth.users via junction table
-- Date: 2024-11-24
-- ============================================================================

-- Create junction table linking users to characters (many-to-many, but limited to 5 per user)
CREATE TABLE user_characters (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  character_id UUID NOT NULL REFERENCES characters(character_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, character_id)
);

-- Indexes for efficient lookups
CREATE INDEX idx_user_characters_user_id ON user_characters(user_id);
CREATE INDEX idx_user_characters_character_id ON user_characters(character_id);
CREATE INDEX idx_user_characters_created_at ON user_characters(created_at);

COMMENT ON TABLE user_characters IS 'Links Supabase auth users to characters (one user can own multiple characters)';
COMMENT ON COLUMN user_characters.user_id IS 'References auth.users(id)';
COMMENT ON COLUMN user_characters.character_id IS 'References characters(character_id)';

-- Enforce character limit per user (max 5 characters)
CREATE OR REPLACE FUNCTION check_user_character_limit()
RETURNS TRIGGER AS $$
DECLARE
  character_count INTEGER;
  max_characters INTEGER := 5;
BEGIN
  -- Count existing characters for this user
  SELECT COUNT(*) INTO character_count
  FROM user_characters
  WHERE user_id = NEW.user_id;
  
  IF character_count >= max_characters THEN
    RAISE EXCEPTION 'User already has maximum number of characters (%)', max_characters;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to enforce character limit on the junction table
CREATE TRIGGER enforce_user_character_limit
  BEFORE INSERT ON user_characters
  FOR EACH ROW
  EXECUTE FUNCTION check_user_character_limit();

COMMENT ON FUNCTION check_user_character_limit IS 'Enforces max 5 characters per user';
COMMENT ON TRIGGER enforce_user_character_limit ON user_characters IS 'Enforces max 5 characters per user';

-- ============================================================================
-- Public Rate Limiting (IP-based)
-- ============================================================================

-- Table for tracking public endpoint rate limits by IP address
CREATE TABLE IF NOT EXISTS public_rate_limits (
  id BIGSERIAL PRIMARY KEY,
  ip_address TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 1,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_public_rate_limits_lookup 
  ON public_rate_limits(ip_address, endpoint, window_start);

-- Cleanup old entries periodically (older than 24 hours)
CREATE INDEX IF NOT EXISTS idx_public_rate_limits_cleanup 
  ON public_rate_limits(created_at);

COMMENT ON TABLE public_rate_limits IS 'Rate limiting for public (unauthenticated) endpoints by IP address';

-- RPC function to check and increment public rate limits
CREATE OR REPLACE FUNCTION check_and_increment_public_rate_limit(
  p_ip_address TEXT,
  p_endpoint TEXT,
  p_max_requests INTEGER,
  p_window_seconds INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_current_count INTEGER;
  v_record_exists BOOLEAN;
BEGIN
  -- Calculate window start time
  v_window_start := NOW() - (p_window_seconds || ' seconds')::INTERVAL;
  
  -- Clean up old records for this IP/endpoint combination
  DELETE FROM public_rate_limits
  WHERE ip_address = p_ip_address
    AND endpoint = p_endpoint
    AND window_start <= v_window_start;
  
  -- Try to get existing record within window
  SELECT request_count INTO v_current_count
  FROM public_rate_limits
  WHERE ip_address = p_ip_address
    AND endpoint = p_endpoint
    AND window_start > v_window_start
  ORDER BY window_start DESC
  LIMIT 1
  FOR UPDATE;
  
  -- Check if record exists
  v_record_exists := FOUND;
  
  IF NOT v_record_exists THEN
    -- No recent record, create new one
    INSERT INTO public_rate_limits (ip_address, endpoint, request_count, window_start)
    VALUES (p_ip_address, p_endpoint, 1, NOW());
    RETURN TRUE;
  ELSIF v_current_count >= p_max_requests THEN
    -- Rate limit exceeded
    RETURN FALSE;
  ELSE
    -- Increment counter
    UPDATE public_rate_limits
    SET request_count = request_count + 1,
        updated_at = NOW()
    WHERE ip_address = p_ip_address
      AND endpoint = p_endpoint
      AND window_start > v_window_start;
    RETURN TRUE;
  END IF;
END;
$$;

COMMENT ON FUNCTION check_and_increment_public_rate_limit IS 'Check and increment rate limit for public endpoints by IP address';

-- Cleanup function (can be called periodically via cron or manually)
CREATE OR REPLACE FUNCTION cleanup_old_public_rate_limits()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_deleted_count INTEGER;
BEGIN
  DELETE FROM public_rate_limits
  WHERE created_at < NOW() - INTERVAL '24 hours';
  
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RETURN v_deleted_count;
END;
$$;

COMMENT ON FUNCTION cleanup_old_public_rate_limits IS 'Clean up rate limit records older than 24 hours';

