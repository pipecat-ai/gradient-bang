import { createContext, useContext } from "react";

/**
 * Game context
 */
interface GameContextProps {
  sendUserTextInput: (text: string) => void;
}

export const GameContext = createContext<GameContextProps>({
  sendUserTextInput: () => {},
});

export const useGameContext = () => {
  const context = useContext(GameContext);
  if (context === undefined) {
    throw new Error("useGameContext must be used within a GameProvider");
  }
  return context;
};
