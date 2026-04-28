import { sql as sharedPlayers } from "./_shared_players.ts";
import { sql as alphaSparrow } from "./alpha_sparrow.ts";
import { sql as betaKestrel } from "./beta_kestrel.ts";
import { sql as deltaFleet } from "./delta_fleet.ts";
import { sql as epsilonCorp } from "./epsilon_corp.ts";
import { sql as gammaExplorer } from "./gamma_explorer.ts";
import { sql as orionVale } from "./orion_vale.ts";
import { sql as phiTrader } from "./phi_trader.ts";

/** Slug → SQL mapping for individual character resets. */
export const SEED_BY_SLUG: Record<string, string> = {
  alpha_sparrow: alphaSparrow,
  beta_kestrel: betaKestrel,
  delta_fleet: deltaFleet,
  epsilon_corp: epsilonCorp,
  gamma_explorer: gammaExplorer,
  orion_vale: orionVale,
  phi_trader: phiTrader,
};

/** Ordered list for seed-all (shared players first, then alphabetical). */
export const ALL_SEEDS: Array<{ name: string; sql: string }> = [
  { name: "_shared_players", sql: sharedPlayers },
  { name: "alpha_sparrow", sql: alphaSparrow },
  { name: "beta_kestrel", sql: betaKestrel },
  { name: "delta_fleet", sql: deltaFleet },
  { name: "epsilon_corp", sql: epsilonCorp },
  { name: "gamma_explorer", sql: gammaExplorer },
  { name: "orion_vale", sql: orionVale },
  { name: "phi_trader", sql: phiTrader },
];
