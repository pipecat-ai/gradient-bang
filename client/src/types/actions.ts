export type ActionType =
  | "start"
  | "get-my-status"
  | "get-known-ports"
  | "get-my-map";

export interface Action {
  type: ActionType;
  payload?: unknown;
}

export interface StartAction extends Action {
  type: "start";
}

export interface GetMyStatusAction extends Action {
  type: "get-my-status";
}

export interface GetKnownPortListAction extends Action {
  type: "get-known-ports";
}

export interface GetMapRegionAction extends Action {
  type: "get-my-map";
  payload: { center_sector: number; max_hops: number; max_sectors: number };
}
