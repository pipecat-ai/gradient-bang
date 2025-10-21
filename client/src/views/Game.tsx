import { AutoPilot } from "@/components/AutoPilot";
import { Settings } from "@/dialogs/Settings";
import { usePlaySound } from "@/hooks/usePlaySound";
import { ShipVisor } from "@/hud/ShipVisor";
import useGameStore from "@/stores/game";

import { ShipHUD } from "@hud/ShipHUD";
import { StarField } from "@hud/StarField";
import { TopBar } from "@hud/TopBar";

import { useEffect } from "react";

export const Game = () => {
  const playSound = usePlaySound();
  const gameState = useGameStore.use.gameState();

  useEffect(() => {
    if (gameState === "ready") {
      playSound("ambience", { loop: true, once: true });
    }
  }, [playSound, gameState]);

  return (
    <>
      <div className="h-full grid grid-rows-[auto_1fr_auto] w-full z-10 relative">
        {/* Top Bar */}
        <TopBar />

        <div className="flex flex-col items-center justify-center">
          {/* The Whole Wide Universe */}
          <AutoPilot />
        </div>

        {/* HUD */}
        <ShipHUD />
      </div>

      {/* Other Renderables */}
      <ShipVisor />
      <StarField />
      <Settings />
    </>
  );
};

export default Game;
