import { RTVIEvent } from "@pipecat-ai/client-js";
import { useRTVIClientEvent } from "@pipecat-ai/client-react";
import { createContext, useCallback, type ReactNode } from "react";
import useGameStore from "./stores/game";

interface ServerMessage {
  event: string;
  tool_name?: string;
  payload: ServerMessagePayload & Record<string, unknown>;
}

interface ServerMessagePayload {
  delta?: Record<string, unknown>;
  result?: StatusUpdateMessage | Record<string, unknown>;
  summary?: string;
}

interface StatusUpdateMessage {
  id: string;
  name: string;
  last_active?: string;
  sector: number;
  ship: Ship & { credits: number };
  sector_contents?: Sector;
}

interface MapDataMessage {
  sectors_visited: Record<string, SectorMap>;
  total_sectors_visited: number;
  first_visit: string;
  last_update: string;
}

/*
interface TradeResultMessage extends StatusUpdateMessage {
  new_cargo: Cargo;
  new_credits: number;
  trade_type: "buy" | "sell";
  commodity: string;
  units: number;
  price_per_unit: number;
  total_price: number;
}

interface WarpPowerResultMessage {
  new_warp_power: number;
  warp_power_capacity: number;
  new_credits: number;
}
*/

// Action types that can be dispatched to the reducer
export type GameAction =
  | { type: "INIT"; payload: StatusUpdateMessage }
  | { type: "STATUS_UPDATE"; payload: StatusUpdateMessage }
  | { type: "MOVE"; payload: StatusUpdateMessage };
/*| { type: "TRADE"; payload: TradeResultMessage }
  | { type: "CHECK_TRADE"; payload: unknown }
  | { type: "RECHARGE_WARP_POWER"; payload: WarpPowerResultMessage }; 
  | {
      type: "MAP_DATA";
      payload: { sectors_visited: Record<string, IncomingSectorData> };
    }
  | { type: "TASK_START"; payload: unknown }
  | { type: "TASK_STOP"; payload: unknown }
  | { type: "TASK_COMPLETE"; payload: { was_cancelled?: boolean } }
  | { type: "TASK_OUTPUT"; payload: TaskOutput }
  | { type: "RESET_GAME"; payload: unknown };*/

const GameContext = createContext(undefined);

interface GameProviderProps {
  children: ReactNode;
}

export function GameProvider({ children }: GameProviderProps) {
  const gameStore = useGameStore();

  useRTVIClientEvent(
    RTVIEvent.ServerMessage,
    useCallback(
      (e: ServerMessage) => {
        if ("event" in e) {
          console.log("[GAME REDUCER] Server message received", e.event, e);

          // Transform if this is a tool call result so we can handle it like a direct action
          let action: string = e.event;
          let data: ServerMessagePayload = e.payload as ServerMessagePayload;

          if (e.event === "tool_result" && "tool_name" in e) {
            action = e.tool_name!;
            data = e.payload as ServerMessagePayload;
            //if (e.content) {
            //  data = JSON.parse(data.content as string);
            //}
            console.log(
              "[GAME REDUCER] Transformed server message",
              action,
              data
            );
          }

          switch (action) {
            // ----- TOOL CALL
            // Used to preempt actions ahead of results
            // mostly to support transition animations etc.
            case "tool_call": {
              console.log("[GAME REDUCER] Tool call", e);
              const preaction = e.tool_name;
              switch (preaction) {
                case "move":
                  //gameStore.preemptMoveToSectorAction();
                  break;
                default:
                  break;
              }
              break;
            }

            // ----- INIT & STATUS
            case "status.init":
            case "status.update":
            case "my_status": {
              console.log("[GAME REDUCER] Status update", data);
              const status: StatusUpdateMessage =
                "status" in data
                  ? (data.status as StatusUpdateMessage)
                  : (data.result as StatusUpdateMessage);
              const map_data =
                "map_data" in data
                  ? (data.map_data as MapDataMessage)
                  : undefined;

              // Update status data
              // Note: we do a little bit of remapping here to conform
              // the status blob to our store shape
              gameStore.setState({
                ship: status.ship,
                player: {
                  name: status.name,
                  last_active: status.last_active,
                },
                sector: {
                  ...status.sector_contents,
                  id: status.sector,
                },
                credits: status.ship.credits,
              });

              // Update map store with discovered sectors
              if (map_data) {
                gameStore.setMappedSectors(map_data.sectors_visited);
              }

              // If initializing, warp starfield to current sector
              if (action === "status.init") {
                gameStore.moveToSectorAction(
                  {
                    ...status.sector_contents,
                    id: status.sector,
                  },
                  true
                );
              }

              break;
            }

            // ----- MOVE
            case "move":
            case "character.moved": {
              console.log("[GAME] Move", data);
              const result = data.result as StatusUpdateMessage;
              // Map new sector to a Sector object
              const newSector = {
                id: result.sector,
                ...result.sector_contents,
              } as Sector;

              gameStore.moveToSectorAction(newSector);
              break;
            }

            // ----- MAP DATA
            case "my_map": {
              console.log("[GAME] Map data", data);
              //gameStore.setMappedSectors(data.result.sectors_visited);
              break;
            }
            /*
          case "my_map": {
            dispatch({
              type: "MAP_DATA",
              payload: data.result as
                | { sectors_visited: Record<string, IncomingSectorData> }
                | undefined,
            });
            break;
          }

          case "trade": {
            let result;
            if (data.content) {
              result = JSON.parse(data.content as string);
              if (result.error) {
                console.error("[GAME REDUCER] Trade error", result.error);
                break;
              }
            } else {
              result = data.result;
            }
            dispatch({
              type: "TRADE",
              payload: result as TradeResult | undefined,
            });
            break;
          }

          case "check_trade": {
            dispatch({ type: "CHECK_TRADE", payload: data });
            break;
          }

          case "recharge_warp_power": {
            dispatch({
              type: "RECHARGE_WARP_POWER",
              payload: data.result as WarpPowerResult,
            });
            break;
          }

          case "start_task": {
            dispatch({ type: "TASK_START", payload: data });
            break;
          }

          case "stop_task": {
            dispatch({ type: "TASK_STOP", payload: data });
            break;
          }

          case "task-complete": {
            dispatch({
              type: "TASK_COMPLETE",
              payload: data.result || {},
            });
            break;
          }

          case "task-output": {
            dispatch({
              type: "TASK_OUTPUT",
              payload: data as TaskOutput,
            });
            break;
          }*/

            default:
              console.warn(
                "[GAME REDUCER] Unhandled server action:",
                action,
                data
              );
          }

          // ----- SUMMARY
          // Add any summary messages to task output
          if ("summary" in (e.payload as ServerMessagePayload)) {
            console.debug(
              "[GAME] Adding task summary to store",
              e.payload.summary
            );
            gameStore.addTask(e.payload.summary!);
          }
        }
      },
      [gameStore]
    )
  );

  return (
    <GameContext.Provider value={undefined}>{children}</GameContext.Provider>
  );
}

export { GameContext };
