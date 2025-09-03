import { RTVIEvent } from "@pipecat-ai/client-js";
import { usePipecatClient, useRTVIClientEvent } from "@pipecat-ai/client-react";
import type { ReactNode } from "react";
import React, { createContext, useCallback, useReducer } from "react";

// Stores
import useMovementHistoryStore from "./stores/history";
import type { IncomingSectorData } from "./stores/map";
import useMapStore from "./stores/map";
import useSectorStore, { type SectorContents } from "./stores/sector";
import useTaskStore, { type TaskOutput } from "./stores/tasks";

const ServerMessageKey = "gg-action";

/**
 * CLIENT INTERFACES
 */
export interface Cargo {
  fuel_ore: number;
  organics: number;
  equipment: number;
  [key: string]: number | undefined;
}

export interface Ship {
  ship_name: string;
  ship_type: string;
  cargo: Cargo;
  cargo_capacity: number;
  cargo_used: number;
  warp_power: number;
  warp_power_capacity: number;
  shields: number;
  max_shields: number;
  fighters: number;
  max_fighters: number;
  credits: number;
}

export interface Task {
  timestamp: string;
  outputText: string;
}

export interface MovementHistory {
  timestamp: string;
  from: string;
  to: string;
  port?: boolean;
}

export interface GameState {
  id: string;
  ship?: Ship;
}

/**
 * SERVER MESSAGE TYPINGS
 */
type StatusUpdate = {
  id: string;
  sector: number;
  ship?: Ship;
  sector_contents?: SectorContents;
  last_active?: string;
};

type GameAction =
  | { type: "SET_STATUS"; status: StatusUpdate | Partial<StatusUpdate> }
  | { type: "SET_SHIP"; ship: Ship }
  | { type: "RESET_GAME" }
  | { type: "SET_HIGHLIGHTED_COMPONENT"; component: string | null };

// Initial game state
const initialState: GameState = {
  id: "Unknown",
  ship: undefined,
};

/**
 * GAME REDUCER
 */
function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case "SET_STATUS":
      console.log("[GAME] Updating status", action);
      return {
        ...state,
        ...(action.status as Partial<StatusUpdate>),
      };

    case "SET_SHIP": {
      console.log("[GAME] Updating ship", action);
      return {
        ...state,
        ship: { ...state.ship, ...action.ship },
      };
    }

    case "RESET_GAME":
      return initialState;

    default:
      return state;
  }
}

// Create the context
export interface GameContextType {
  game: GameState;
  dispatch: React.Dispatch<GameAction>;
  setShip: (ship: Ship) => void;
  resetGame: () => void;
  getCargo: (resource: string) => number;
  getAllCargo: () => Cargo;
  getStatusFromServer: () => void;
}

const GameContext = createContext<GameContextType | undefined>(undefined);

// Export the context for use in the hook
export { GameContext };

// Provider component
interface GameProviderProps {
  children: ReactNode;
}

export const GameProvider: React.FC<GameProviderProps> = ({ children }) => {
  const [game, dispatch] = useReducer(gameReducer, initialState);
  const sectorStore = useSectorStore();
  const movementHistoryStore = useMovementHistoryStore();
  const mapStore = useMapStore();
  const taskStore = useTaskStore();
  const client = usePipecatClient();

  const setShip = useCallback(
    (ship: Ship) => {
      dispatch({ type: "SET_SHIP", ship });
    },
    [dispatch]
  );

  const handleMovement = useCallback(
    (data: StatusUpdate) => {
      console.log("[GAME] Handling movement", data);
      // 1. Update the current sector
      sectorStore.setSector(data.sector, data.sector_contents);

      // 2. Update movement history
      movementHistoryStore.addMovementHistory({
        timestamp: new Date().toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }),
        from: data.sector,
        to: data.sector,
        port: data.sector_contents?.port,
      });

      // Finally, update our current state
      dispatch({ type: "SET_STATUS", status: data });
    },
    [sectorStore, movementHistoryStore]
  );

  const handleMapData = useCallback(
    (data: unknown) => {
      if (data && typeof data === "object" && "sectors_visited" in data) {
        console.log("[GAME] Map data", data);

        mapStore.importSectorsFromData(
          data.sectors_visited as Record<string, IncomingSectorData>
        );
      }
    },
    [mapStore]
  );

  /*const handleImageBySector = useCallback(
    (hasPort: boolean) => {
      if (hasPort) {
        setImage(PortImage);
      } else {
        setImage(null);
      }
    },
    [setImage]
  );

  const moveToSector = useCallback(
    (sector: string, sectorInfo: unknown) => {
      dispatch({
        type: "ADD_MOVEMENT_HISTORY",
        movementHistory: {
          timestamp: new Date().toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          }),
          from: game.sector ?? "???",
          to: sector,
          port: (sectorInfo as Record<string, unknown>).port_info as boolean,
        } as MovementHistory,
      });
      dispatch({ type: "SET_SECTOR", sector });
      //dispatch({ type: "SET_SECTOR_INFO", sectorInfo });
      handleImageBySector(
        (sectorInfo as Record<string, unknown>).port_info as boolean
      );
    },
    [dispatch, handleImageBySector, game.sector]
  );*/

  const getCargo = useCallback(
    (resource: string) => {
      return game.ship?.cargo[resource] ?? 0;
    },
    [game.ship]
  );

  const getAllCargo = useCallback(() => {
    return game.ship?.cargo ?? { fuel_ore: 0, organics: 0, equipment: 0 };
  }, [game.ship]);

  const getStatusFromServer = useCallback(() => {
    client?.sendClientMessage("get-my-status", { id: game.id });
  }, [client, game]);

  const resetGame = () => {
    dispatch({ type: "RESET_GAME" });
  };

  /**
   * SERVER MESSAGE HANDLER / REDUCER
   */
  useRTVIClientEvent(
    RTVIEvent.ServerMessage,
    useCallback(
      (data: Record<string, unknown>) => {
        if (ServerMessageKey in data) {
          const action = data[ServerMessageKey];
          console.log("[GAME] Server message received", action, data);
          switch (action) {
            // ----- INIT & STATUS
            case "init":
            case "my_status": {
              const newStatus: StatusUpdate = data.result as StatusUpdate;
              dispatch({
                type: "SET_STATUS",
                status: newStatus,
              });
              sectorStore.setSector(
                newStatus.sector,
                newStatus.sector_contents
              );

              // Handle any map data as part of update
              handleMapData(data.map_data);
              break;
            }

            // ----- MOVEMENT
            case "move": {
              handleMovement(data.result as StatusUpdate);
              break;
            }

            // ----- MAP DATA
            case "my_map": {
              handleMapData(data.result);
              break;
            }

            // ----- WARP POWER
            case "recharge_warp_power": {
              dispatch({
                type: "SET_SHIP",
                ship: {
                  warp_power: (data.result as Record<string, unknown>)
                    .new_warp_power as number,
                  warp_power_capacity: (data.result as Record<string, unknown>)
                    .warp_power_capacity as number,
                  credits: (data.result as Record<string, unknown>)
                    .new_credits as number,
                } as Ship,
              });
              break;
            }

            // ----- TASKS
            case "start_task":
              taskStore.setActive(true);
              break;
            case "stop_task":
              taskStore.setActive(false);
              taskStore.setStatus("cancelled");
              break;
            case "task-complete":
              taskStore.setActive(false);
              if (
                data.result &&
                "was_cancelled" in (data.result as Record<string, unknown>)
              ) {
                taskStore.setStatus("cancelled");
              } else {
                taskStore.setStatus("completed");
              }
              break;
            case "task-output":
              taskStore.addTaskOutput({
                ...(data as Record<string, unknown>),
                timestamp: new Date().toISOString(),
              } as TaskOutput);
              break;

            // ----- DEFAULT
            default:
              console.warn("Unhandled game action", action);
              break;
          }
        }
      },
      [sectorStore, handleMovement, handleMapData, taskStore]
    )
  );

  const value: GameContextType = {
    game,
    getStatusFromServer,
    dispatch,
    setShip,
    resetGame,
    getCargo,
    getAllCargo,
  };

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
};
