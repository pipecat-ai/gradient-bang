import { produce } from "immer"
import type { StateCreator } from "zustand"

export type CombatStrategyTemplate = "balanced" | "offensive" | "defensive"

export interface ShipCombatStrategy {
  /** Absent when the ship has no stored row and is using the server default. */
  strategy_id?: string
  ship_id: string
  /** Base doctrine. `custom_prompt` layers on top additively. */
  template: CombatStrategyTemplate
  /** Optional commander guidance appended to the base doctrine. */
  custom_prompt: string | null
  /** Full base-doctrine text (matches the `template`). Server-provided so UI
   *  can display without a separate fetch. */
  doctrine?: string
  /** Absent when this is a synthetic default (no stored row yet). */
  updated_at?: string
  /** True when the strategy is the server-side default (no row exists).
   *  The UI uses this to show a "Default" indicator. */
  is_default?: boolean
}

export interface StrategiesSlice {
  /**
   * ship_id → combat strategy state. Three cases:
   * - key absent → never fetched
   * - value is null → fetched, no strategy set
   * - value is a strategy → fetched, strategy present
   */
  shipStrategies: Record<string, ShipCombatStrategy | null>
  /** Monotonic epoch-ms counter bumped every time a ship's strategy entry
   *  changes. Consumers that need to detect same-value re-fetches (e.g. a
   *  "Refresh" button spinner) should watch this timestamp, not the value. */
  strategyUpdatedAt: Record<string, number>

  setShipStrategy: (shipId: string, strategy: ShipCombatStrategy) => void
  clearShipStrategy: (shipId: string) => void
  resetShipStrategies: () => void
}

export const createStrategiesSlice: StateCreator<StrategiesSlice> = (set) => ({
  shipStrategies: {},
  strategyUpdatedAt: {},

  setShipStrategy: (shipId, strategy) =>
    set(
      produce((state: StrategiesSlice) => {
        state.shipStrategies[shipId] = strategy
        state.strategyUpdatedAt[shipId] = Date.now()
      })
    ),

  clearShipStrategy: (shipId) =>
    set(
      produce((state: StrategiesSlice) => {
        // Keep the key with a null value so consumers can distinguish
        // "fetched, empty" from "never fetched".
        state.shipStrategies[shipId] = null
        state.strategyUpdatedAt[shipId] = Date.now()
      })
    ),

  resetShipStrategies: () =>
    set(
      produce((state: StrategiesSlice) => {
        state.shipStrategies = {}
        state.strategyUpdatedAt = {}
      })
    ),
})
