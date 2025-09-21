import { RTVIEvent } from "@pipecat-ai/client-js";
import { usePipecatClient, useRTVIClientEvent } from "@pipecat-ai/client-react";
import type { ReactNode } from "react";
import React, { createContext, useCallback, useReducer } from "react";

// Stores
import { useUI } from "./hooks/useUI";
import useMovementHistoryStore from "./stores/history";
import type { IncomingSectorData } from "./stores/map";
import useMapStore from "./stores/map";
import useSectorStore, { type SectorContents } from "./stores/sector";
import useStarfieldStore from "./stores/starfield";
import useTaskStore, { type TaskOutput } from "./stores/tasks";
import useTradeHistoryStore, { type TradeHistoryItem } from "./stores/trades";

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
        ship: state.ship ? { ...state.ship, ...action.ship } : action.ship,
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
  const starfieldStore = useStarfieldStore();
  const client = usePipecatClient();
  const { resetActivePanels } = useUI();
  const tradeHistoryStore = useTradeHistoryStore();

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
        const rawAction =
          typeof data.event === "string"
            ? (data.event as string)
            : (data[ServerMessageKey] as string | undefined);

        if (!rawAction) {
          return;
        }

        console.log("[GAME] Server message received", rawAction, data);

        let action = rawAction;
        let payload: Record<string, unknown> =
          (typeof data.payload === "object" && data.payload !== null
            ? (data.payload as Record<string, unknown>)
            : (data.result as Record<string, unknown>)) ||
          (data as Record<string, unknown>);

        // Transform if this is a tool call result
        if (action === "tool_result" && "tool_name" in data) {
          action = data.tool_name as string;
          payload = (data.payload as Record<string, unknown>) ?? {};
          console.log("[GAME] Transformed tool result", action, payload);
        }

        switch (action) {
          case "status.init": {
            const statusPayload = payload.status as StatusUpdate | undefined;
            if (statusPayload) {
              dispatch({ type: "SET_STATUS", status: statusPayload });
              sectorStore.setSector(
                statusPayload.sector,
                statusPayload.sector_contents
              );
            }
            if (payload.map_data) {
              handleMapData(payload.map_data);
            }
            break;
          }
          case "status.update":
          case "my_status":
          case "init": {
            const newStatus =
              (payload as StatusUpdate) ?? (payload.result as StatusUpdate);
            if (!newStatus) {
              break;
            }
            dispatch({
              type: "SET_STATUS",
              status: newStatus,
            });
            sectorStore.setSector(
              newStatus.sector,
              newStatus.sector_contents
            );
            if (payload.map_data) {
              handleMapData(payload.map_data);
            }
            break;
          }
          case "move":
          case "character.moved": {
            console.log("[MOVE] Movement", payload);
            resetActivePanels();
            if (payload.content) {
              const d = JSON.parse(payload.content as string);
              handleMovement(d as StatusUpdate);
            } else {
              const moveStatus =
                (payload.result as StatusUpdate) ||
                (payload as unknown as StatusUpdate);
              handleMovement(moveStatus);
            }
            break;
          }
          case "my_map": {
            handleMapData(payload.result ?? payload);
            break;
          }
          case "trade": {
            let result: unknown = payload.result ?? payload;
            if (payload.content) {
              result = JSON.parse(payload.content as string);
              if ((result as { error?: unknown }).error) {
                console.error("[GAME] Trade error", (result as { error: unknown }).error);
                break;
              }
            }
            const tradeResult = result as StatusUpdate & {
              new_cargo: Cargo;
              new_credits: number;
            };
            dispatch({
              type: "SET_SHIP",
              ship: {
                cargo: tradeResult.new_cargo,
                credits: tradeResult.new_credits,
              } as Ship,
            });
            const historyResult = result as TradeHistoryItem;
            tradeHistoryStore.addTrade({
              timestamp: new Date().toISOString(),
              trade_type: historyResult.trade_type,
              commodity: historyResult.commodity,
              units: historyResult.units,
              price_per_unit: historyResult.price_per_unit,
              total_price: historyResult.total_price,
            } as TradeHistoryItem);
            getStatusFromServer();
            break;
          }
          case "check_trade": {
            const instance = starfieldStore.getInstance();
            if (!instance) return;
            const go = instance.getAllGameObjects()[0];
            if (!go) return;
            instance.selectGameObject(go.id);
            break;
          }
          case "recharge_warp_power": {
            const result = payload.result as Record<string, unknown>;
            dispatch({
              type: "SET_SHIP",
              ship: {
                warp_power: result?.new_warp_power as number,
                warp_power_capacity: result?.warp_power_capacity as number,
                credits: result?.new_credits as number,
              } as Ship,
            });
            break;
          }
          case "start_task":
            taskStore.setActive(true);
            taskStore.setStatus(undefined);
            resetActivePanels();
            break;
          case "stop_task":
            taskStore.setActive(false);
            taskStore.setStatus("cancelled");
            break;
          case "task-complete":
            taskStore.setActive(false);
            if (
              payload.result &&
              "was_cancelled" in (payload.result as Record<string, unknown>)
            ) {
              taskStore.setStatus("cancelled");
            } else {
              taskStore.setStatus("completed");
            }
            break;
          case "task-output":
            taskStore.addTaskOutput({
              ...(payload as Record<string, unknown>),
              timestamp: new Date().toISOString(),
            } as TaskOutput);
            break;
          default:
            console.warn("Unhandled game action", action);
            break;
        }
      },
      [
        sectorStore,
        handleMovement,
        handleMapData,
        taskStore,
        starfieldStore,
        tradeHistoryStore,
        getStatusFromServer,
        resetActivePanels,
      ]
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
