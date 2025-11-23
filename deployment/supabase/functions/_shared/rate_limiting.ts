import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

import { RATE_LIMITS } from './constants.ts';

export class RateLimitError extends Error {
  constructor(message = 'rate limit exceeded') {
    super(message);
    this.name = 'RateLimitError';
  }
}

export async function enforceRateLimit(
  supabase: SupabaseClient,
  characterId: string | null,
  endpoint: string,
): Promise<void> {
  if (!characterId) {
    // Anonymous/system actions skip rate limits by design.
    return;
  }

  const rule = RATE_LIMITS[endpoint] ?? RATE_LIMITS.default;

  const { data, error } = await supabase.rpc('check_and_increment_rate_limit', {
    p_character_id: characterId,
    p_endpoint: endpoint,
    p_max_requests: rule.max,
    p_window_seconds: rule.window,
  });

  if (error) {
    throw new Error(`rate limit RPC failed: ${error.message}`);
  }

  if (data !== true) {
    throw new RateLimitError();
  }
}
