export const MAX_QUERY_RESULTS = 1000;
export const FIGHTER_PRICE = 50;

export type RateLimitRule = {
  max: number;
  window: number; // seconds
};

// Rate limits tuned for production load and test stress scenarios
// Balance: Prevent DoS attacks while supporting legitimate high-frequency activity
// Rationale:
//   - 200 req/min = 3.3 req/sec sustained (allows bursts up to 50-100 concurrent)
//   - Still blocks abuse (e.g., 1000 req/min would indicate malicious activity)
//   - Test stress scenarios (50 concurrent trades) validate real-world capacity
export const RATE_LIMITS: Record<string, RateLimitRule> = {
  default: { max: 120, window: 60 }, // Up from 60
  join: { max: 200, window: 60 }, // Reconnections, session management (was 120)
  my_status: { max: 200, window: 60 }, // Frequent game state polling (was 60)
  move: { max: 200, window: 60 }, // Rapid exploration (was 120)
  plot_course: { max: 120, window: 60 }, // Pathfinding (was 60)
  path_with_region: { max: 120, window: 60 }, // Regional pathfinding (was 60)
  trade: { max: 200, window: 60 }, // High-frequency trading bursts (was 45)
  recharge_warp_power: { max: 60, window: 60 }, // Up from 30
  transfer_warp_power: { max: 60, window: 60 }, // Up from 30
  transfer_credits: { max: 60, window: 60 }, // Up from 30
  bank_transfer: { max: 120, window: 60 }, // Up from 30 (raised for test suite with 9 bank operations)
  dump_cargo: { max: 120, window: 60 }, // Up from 60
  purchase_fighters: { max: 60, window: 60 }, // Up from 30
  ship_purchase: { max: 30, window: 60 }, // Expensive DB operation, keep conservative
  combat_initiate: { max: 60, window: 60 }, // Up from 30
  combat_action: { max: 200, window: 60 }, // Rapid combat rounds (was 120)
  corporation_create: { max: 20, window: 60 }, // Up from 10
  corporation_join: { max: 60, window: 60 }, // Up from 30
  corporation_leave: { max: 60, window: 60 }, // Up from 30
  corporation_kick: { max: 40, window: 60 }, // Up from 20
  corporation_regenerate_invite_code: { max: 20, window: 60 }, // Up from 10
  corporation_list: { max: 60, window: 60 }, // Up from 30
  corporation_info: { max: 120, window: 60 }, // Up from 60
  my_corporation: { max: 120, window: 60 }, // Up from 60

  // Public endpoints - stricter limits to prevent abuse
  register: { max: 5, window: 300 }, // 5 registrations per 5 minutes per IP
  login: { max: 20, window: 300 }, // 20 logins per 5 minutes per IP
  character_create: { max: 10, window: 60 }, // 10 characters per minute per user
  character_list: { max: 30, window: 60 }, // 30 list requests per minute per user
};
