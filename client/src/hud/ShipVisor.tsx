import { usePlaySound } from "@/hooks/usePlaySound";
import useGameStore from "@/stores/game";
import { useEffect, useState } from "react";

import { wait } from "@/utils/animation";

export const ShipVisor = () => {
  const gameState = useGameStore.use.gameState();
  const playSound = usePlaySound();
  const [isOpen, setIsOpen] = useState(false);

  /*
   * Debounce visor opening and start sound FX
   */
  useEffect(() => {
    const openVisor = async () => {
      if (gameState === "ready") {
        await wait(2000);
        setIsOpen(true);
        playSound("start");
      }
    };

    openVisor();
  }, [playSound, gameState]);

  return <div id="visor" className={isOpen ? "open" : ""}></div>;
};
