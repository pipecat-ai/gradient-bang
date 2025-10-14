import { usePlaySound } from "@/hooks/usePlaySound";
import useGameStore from "@/stores/game";
import { useEffect } from "react";

export const ShipVisor = () => {
  const gameState = useGameStore.use.gameState();
  const playSound = usePlaySound();

  /*
   * Play start sound FX on ready
   */
  useEffect(() => {
    if (gameState === "ready") {
      playSound("start");
    }
  }, [playSound, gameState]);

  return <div id="visor" className={gameState === "ready" ? "open" : ""}></div>;
};
