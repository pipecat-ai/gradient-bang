import { createContext, useContext } from "react";

import type { Action } from "@/types/actions";

/**
 * Game context
 */
interface GameContextProps {
  sendUserTextInput: (text: string) => void;
  dispatchAction: (action: Action) => void;
  initialize: () => void;
}

export const GameContext = createContext<GameContextProps>({
  sendUserTextInput: () => {},
  dispatchAction: () => {},
  initialize: () => {},
});

export const useGameContext = () => {
  const context = useContext(GameContext);
  if (context === undefined) {
    throw new Error("useGameContext must be used within a GameProvider");
  }
  return context;
};
