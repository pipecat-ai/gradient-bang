import { useContext } from "react";
import type { GameContextType } from "../GameContext";
import { GameContext } from "../GameContext";

export const useGameManager = (): GameContextType => {
  const context = useContext(GameContext);
  if (context === undefined) {
    throw new Error("useGameManager must be used within a GameProvider");
  }
  return context;
};
