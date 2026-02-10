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

export interface GetTaskHistoryAction {
  type: "get-task-history"
  payload: {
    ship_id?: string
    max_rows?: number
  }
}

export interface GetMapRegionAction {
  type: "get-my-map"
  payload: {
    center_sector?: number
    bounds?: number
    max_hops?: number // @DEPRECATED: Use bounds instead
    max_sectors?: number // @DEPRECATED: Use bounds instead
    fit_sectors?: number[]
  }
}

export interface GetMyShipsAction {
  type: "get-my-ships"
}

export interface CancelTaskAction {
  type: "cancel-task"
  payload: { task_id: string }
}

export interface RenameShipAction {
  type: "rename-ship"
  payload: { ship_id: string; ship_name: string }
}

export interface GetChatHistoryAction {
  type: "get-chat-history"
  payload?: {
    since_hours?: number
    max_rows?: number
  }
}

type ActionMeta = { async?: boolean }

export type GameAction = (
  | StartAction
  | GetMyStatusAction
  | GetKnownPortListAction
  | GetMapRegionAction
  | GetTaskHistoryAction
  | GetMyShipsAction
  | CancelTaskAction
  | RenameShipAction
  | GetChatHistoryAction
) &
  ActionMeta

export type ActionType = GameAction["type"]
