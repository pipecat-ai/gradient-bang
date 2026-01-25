import { createContext, useContext } from "react";

import type { GameAction } from "@/types/actions";

/**
 * Game context
 */
interface GameContextProps {
  sendUserTextInput: (text: string) => void;
  dispatchAction: (action: GameAction) => Promise<void> | undefined;
  initialize: () => void;
}

export const GameContext = createContext<GameContextProps>({
  sendUserTextInput: () => {},
  dispatchAction: (action: GameAction) => {
    void action
    return undefined
  },
  initialize: () => {},
});

export const useGameContext = () => {
  const context = useContext(GameContext);
  if (context === undefined) {
    throw new Error("useGameContext must be used within a GameProvider");
  }
  return context;
};
