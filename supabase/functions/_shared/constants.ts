export const MAX_QUERY_RESULTS = 1000;
export const FIGHTER_PRICE = 50;

export type RateLimitRule = {
  max: number;
  window: number; // seconds
};

export const RATE_LIMITS: Record<string, RateLimitRule> = {
  default: { max: 60, window: 60 },
  join: { max: 120, window: 60 },
  my_status: { max: 60, window: 60 },
  move: { max: 120, window: 60 },
  plot_course: { max: 60, window: 60 },
  path_with_region: { max: 60, window: 60 },
  trade: { max: 45, window: 60 },
  recharge_warp_power: { max: 30, window: 60 },
  transfer_warp_power: { max: 30, window: 60 },
  transfer_credits: { max: 30, window: 60 },
  bank_transfer: { max: 30, window: 60 },
  dump_cargo: { max: 60, window: 60 },
  purchase_fighters: { max: 30, window: 60 },
  ship_purchase: { max: 15, window: 60 },
  combat_initiate: { max: 30, window: 60 },
  combat_action: { max: 120, window: 60 },
};
