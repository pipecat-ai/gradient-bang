/**
 * Game Actions
 *
 * Discriminated union of all action types. TypeScript narrows the payload
 * type based on the `type` discriminant, ensuring type-safe dispatch.
 */

export interface StartAction {
  type: "start"
}

export interface GetMyStatusAction {
  type: "get-my-status"
}

export interface GetKnownPortListAction {
  type: "get-known-ports"
}

export interface GetMapRegionAction {
  type: "get-my-map"
  payload: {
    center_sector: number
    max_hops?: number
    max_sectors?: number
  }
}

export interface GetMyShipsAction {
  type: "get-my-ships"
}

export interface CancelTaskAction {
  type: "cancel-task"
  payload: { task_id: string }
}

type ActionMeta = { async?: boolean }

export type GameAction = (
  | StartAction
  | GetMyStatusAction
  | GetKnownPortListAction
  | GetMapRegionAction
  | GetMyShipsAction
  | CancelTaskAction
) &
  ActionMeta

export type ActionType = GameAction["type"]
