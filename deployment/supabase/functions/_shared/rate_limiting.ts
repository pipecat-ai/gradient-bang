import type { SupabaseClient } from "@supabase/supabase-js";

import { RATE_LIMITS } from "./constants.ts";

export class RateLimitError extends Error {
  constructor(message = "rate limit exceeded") {
    super(message);
    this.name = "RateLimitError";
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

  const { data, error } = await supabase.rpc("check_and_increment_rate_limit", {
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

/**
 * Enforce rate limit for public endpoints based on IP address.
 * Uses stricter limits to prevent abuse of unauthenticated endpoints.
 */
export async function enforcePublicRateLimit(
  supabase: SupabaseClient,
  req: Request,
  endpoint: string,
): Promise<void> {
  // Extract IP from headers (Cloudflare/Supabase Edge provides these)
  const ip =
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";

  if (ip === "unknown") {
    console.warn("public_rate_limit: Could not determine IP address");
  }

  const rule = RATE_LIMITS[endpoint] ?? { max: 10, window: 60 };

  // For now, use a simple in-memory rate limiting approach
  // In production, you'd want to use a proper rate limiting table
  // We'll create the RPC function for this in the migration
  const { data, error } = await supabase.rpc(
    "check_and_increment_public_rate_limit",
    {
      p_ip_address: ip,
      p_endpoint: endpoint,
      p_max_requests: rule.max,
      p_window_seconds: rule.window,
    },
  );

  if (error) {
    // If the RPC doesn't exist yet (pre-migration), just log and continue
    console.warn(`public rate limit RPC failed: ${error.message}`);
    return;
  }

  if (data !== true) {
    throw new RateLimitError(`Rate limit exceeded. Please try again later.`);
  }
}
