import type { ComponentProps } from "react"

import type { Progress } from "@/components/primitives/Progress"

export type ProgressColor = ComponentProps<typeof Progress>["color"]

export interface ColorThreshold {
  threshold: number
  color: ProgressColor
}

/**
 * Gets the appropriate color based on a percentage value and color thresholds.
 * Thresholds should be ordered from lowest to highest.
 *
 * @param percentage - The percentage value (0-100)
 * @param thresholds - Array of color thresholds ordered from lowest to highest
 * @param defaultColor - Color to use if percentage exceeds all thresholds
 * @returns The appropriate color for the given percentage
 *
 * @example
 * ```ts
 * const thresholds = [
 *   { threshold: 25, color: "destructive" },
 *   { threshold: 50, color: "warning" },
 * ]
 * getColorFromThresholds(10, thresholds, "terminal") // "destructive"
 * getColorFromThresholds(30, thresholds, "terminal") // "warning"
 * getColorFromThresholds(75, thresholds, "terminal") // "terminal"
 * ```
 */
export function getColorFromThresholds(
  percentage: number,
  thresholds: ColorThreshold[],
  defaultColor: ProgressColor
): ProgressColor {
  return thresholds.find((t) => percentage <= t.threshold)?.color ?? defaultColor
}

/** Color thresholds for combat stats (fighters, shields) */
export const combatThresholds: ColorThreshold[] = [
  { threshold: 15, color: "destructive" },
  { threshold: 25, color: "warning" },
]

/** Color thresholds for fuel stats */
export const fuelThresholds: ColorThreshold[] = [
  { threshold: 25, color: "destructive" },
  { threshold: 50, color: "warning" },
]

/** Color thresholds for cargo capacity (based on empty holds %) */
export const cargoThresholds: ColorThreshold[] = [
  { threshold: 0, color: "destructive" },
  { threshold: 10, color: "warning" },
]
