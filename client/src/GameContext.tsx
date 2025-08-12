import { RTVIEvent } from "@pipecat-ai/client-js";
import { useRTVIClientEvent } from "@pipecat-ai/client-react";
import type { ReactNode } from "react";
import React, { createContext, useCallback, useReducer } from "react";

import PortImage from "./images/port-1.png";
import ShipKestrel from "./images/ship-kestrel.png";

const ShipImageMap = {
  kestrel: ShipKestrel,
};

export interface Cargo {
  fo: number;
  og: number;
  eq: number;
  [key: string]: number | undefined;
}

export interface Ship {
  name: string;
  warp: number;
  warpCapacity: number;
  capcity: number;
  cargo: Cargo;
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
  credits: number;
  ship?: Ship;
  sector?: string | null;
  image?: string | null;
  taskStatus: "idle" | "working" | "completed" | "failed";
  tasks: Task[];
  movementHistory: MovementHistory[];
  sectorInfo: unknown;
}

// Define action types for the reducer
type GameAction =
  | { type: "SET_SHIP"; ship: Ship }
  | { type: "SET_SECTOR"; sector: string | null }
  | { type: "SET_SECTOR_INFO"; sectorInfo: unknown }
  | { type: "SET_IMAGE"; image: string | null }
  | {
      type: "SET_TASK_STATUS";
      taskStatus: "idle" | "working" | "completed" | "failed";
    }
  | { type: "ADD_TASK"; task: Task }
  | { type: "ADD_MOVEMENT_HISTORY"; movementHistory: MovementHistory }
  | { type: "RESET_GAME" }
  | { type: "ADD_CREDITS"; credits: number }
  | { type: "SET_HIGHLIGHTED_COMPONENT"; component: string | null };

// Initial game state
const initialState: GameState = {
  ship: undefined,
  credits: 0,
  sector: null,
  movementHistory: [],
  taskStatus: "idle",
  tasks: [],
  sectorInfo: {},
};

// Game reducer function
function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case "SET_SHIP": {
      const image =
        ShipImageMap[
          action.ship.name.toLowerCase() as keyof typeof ShipImageMap
        ];
      return {
        ...state,
        ship: action.ship,
        image: image,
      };
    }

    case "SET_SECTOR":
      return {
        ...state,
        sector: action.sector,
      };

    case "SET_SECTOR_INFO":
      return {
        ...state,
        sectorInfo: action.sectorInfo,
      };

    case "SET_IMAGE":
      return {
        ...state,
        image: action.image,
      };

    case "SET_TASK_STATUS":
      return {
        ...state,
        taskStatus: action.taskStatus,
      };

    case "ADD_TASK":
      return {
        ...state,
        tasks: [...state.tasks, action.task],
      };

    case "ADD_MOVEMENT_HISTORY":
      return {
        ...state,
        movementHistory: [...state.movementHistory, action.movementHistory],
      };

    case "RESET_GAME":
      return initialState;

    case "ADD_CREDITS":
      return {
        ...state,
        credits: state.credits + action.credits,
      };
    default:
      return state;
  }
}

// Create the context
export interface GameContextType {
  game: GameState;
  dispatch: React.Dispatch<GameAction>;
  setShip: (ship: Ship) => void;
  moveToSector: (sector: string, sectorInfo: unknown) => void;
  setImage: (image: string | null) => void;
  setTaskStatus: (
    taskStatus: "idle" | "working" | "completed" | "failed"
  ) => void;
  addTask: (task: Task) => void;
  addMovementHistory: (movementHistory: MovementHistory) => void;
  resetGame: () => void;
  getCargo: (resource: string) => number;
  getAllCargo: () => Cargo;
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

  const setImage = useCallback(
    (image: string | null) => {
      dispatch({ type: "SET_IMAGE", image });
    },
    [dispatch]
  );

  const setShip = useCallback(
    (ship: Ship) => {
      dispatch({ type: "SET_SHIP", ship });
    },
    [dispatch]
  );

  const handleImageBySector = useCallback(
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
      dispatch({ type: "SET_SECTOR_INFO", sectorInfo });
      handleImageBySector(
        (sectorInfo as Record<string, unknown>).port_info as boolean
      );
    },
    [dispatch, handleImageBySector, game.sector]
  );

  const getCargo = useCallback(
    (resource: string) => {
      return game.ship?.cargo[resource] ?? 0;
    },
    [game.ship]
  );

  const getAllCargo = useCallback(() => {
    return game.ship?.cargo ?? { fo: 0, og: 0, eq: 0 };
  }, [game.ship]);

  const setTaskStatus = (
    taskStatus: "idle" | "working" | "completed" | "failed"
  ) => {
    dispatch({ type: "SET_TASK_STATUS", taskStatus });
  };

  const addTask = (task: Task) => {
    dispatch({ type: "ADD_TASK", task });
  };

  const addMovementHistory = (movementHistory: MovementHistory) => {
    dispatch({ type: "ADD_MOVEMENT_HISTORY", movementHistory });
  };

  const resetGame = () => {
    dispatch({ type: "RESET_GAME" });
  };

  useRTVIClientEvent(
    RTVIEvent.ServerMessage,
    useCallback(
      (data: Record<string, unknown>) => {
        console.log(data);
        if ("gg-action" in data) {
          const action = data["gg-action"];
          switch (action) {
            /* STATUS UPDATES */
            case "my_status":
              moveToSector(data.current_sector as string, data.sector_contents);
              break;

            /* MOVEMENT */
            case "move":
              moveToSector(data.new_sector as string, data.sector_contents);
              break;
            default:
              console.warn("Unhandled game action", action);
              break;
          }
        }
      },
      [moveToSector]
    )
  );

  const value: GameContextType = {
    game,
    dispatch,
    setShip,
    moveToSector,
    setImage,
    addTask,
    addMovementHistory,
    resetGame,
    setTaskStatus,
    getCargo,
    getAllCargo,
  };

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
};
