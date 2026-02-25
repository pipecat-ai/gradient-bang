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
    fit_sectors?: number[]
  }
}

export interface GetMyShipsAction {
  type: "get-my-ships"
}

export interface GetMyCorporationAction {
  type: "get-my-corporation"
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

export interface SayTextAction {
  type: "say-text"
  payload: {
    voice_id?: string
    text: string
  }
}

export interface SayTextDimissAction {
  type: "say-text-dismiss"
}

export interface AssignQuestAction {
  type: "assign-quest"
  payload: { quest_code: string }
}

type ActionMeta = { async?: boolean }

export type GameAction = (
  | StartAction
  | GetMyStatusAction
  | GetKnownPortListAction
  | GetMapRegionAction
  | GetTaskHistoryAction
  | GetMyShipsAction
  | GetMyCorporationAction
  | CancelTaskAction
  | RenameShipAction
  | GetChatHistoryAction
  | SayTextAction
  | SayTextDimissAction
  | AssignQuestAction
) &
  ActionMeta

export type ActionType = GameAction["type"]
