import type { ShipDefinitionRow, ShipRow } from './status.ts';
import { FIGHTER_PRICE } from './constants.ts';

const AUTONOMOUS_TYPES = new Set(['autonomous_probe', 'autonomous_light_hauler']);

export function isAutonomousShipType(shipType: string): boolean {
  return AUTONOMOUS_TYPES.has(shipType);
}

export function calculateHullPrice(definition: ShipDefinitionRow): number {
  const fightersValue = (definition.fighters ?? 0) * FIGHTER_PRICE;
  return Math.max(0, (definition.purchase_price ?? 0) - fightersValue);
}

export function calculateTradeInValue(ship: ShipRow, definition: ShipDefinitionRow): number {
  const fightersRemaining = Math.max(
    0,
    Math.min(ship.current_fighters ?? definition.fighters ?? 0, definition.fighters ?? 0),
  );
  return calculateHullPrice(definition) + fightersRemaining * FIGHTER_PRICE;
}
