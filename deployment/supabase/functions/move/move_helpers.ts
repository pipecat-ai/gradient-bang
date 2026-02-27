import type { ShipRow } from "../_shared/status.ts";

/**
 * Build the post-move ship state in memory, avoiding a DB re-load.
 * After hyperspace, we know exactly what changed:
 * - current_sector = destination
 * - current_warp_power -= warpCost (already applied by pgStartHyperspace)
 * - hyperspace fields cleared
 */
export function buildPostMoveShip(
  ship: ShipRow,
  destination: number,
  warpCost: number,
): ShipRow {
  return {
    ...ship,
    current_sector: destination,
    current_warp_power: ship.current_warp_power - warpCost,
    in_hyperspace: false,
    hyperspace_destination: null,
    hyperspace_eta: null,
  };
}
