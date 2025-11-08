export const MAX_QUERY_RESULTS = 1000;

export type RateLimitRule = {
  max: number;
  window: number; // seconds
};

export const RATE_LIMITS: Record<string, RateLimitRule> = {
  default: { max: 60, window: 60 },
  join: { max: 30, window: 60 },
  my_status: { max: 60, window: 60 },
  move: { max: 120, window: 60 },
  trade: { max: 45, window: 60 },
};
