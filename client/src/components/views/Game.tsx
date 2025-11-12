import { Settings } from "@/components/dialogs/Settings";
import { ToastContainer } from "@/components/toasts/ToastContainer";
import { useNotificationSound } from "@/hooks/useNotificationSound";
import { usePlaySound } from "@/hooks/usePlaySound";
import useGameStore from "@/stores/game";
import { ShipVisor } from "@hud/ShipVisor";

import { ShipHUD } from "@hud/ShipHUD";
import { StarField } from "@hud/StarField";
import { TopBar } from "@hud/TopBar";

import { ScreenContainer } from "@/components/screens/ScreenContainer";
import { ActivityStream } from "@hud/ActivityStream";
import { useEffect } from "react";

export const Game = () => {
  const { playSound } = usePlaySound();
  const gameState = useGameStore.use.gameState();

  useNotificationSound();

  useEffect(() => {
    if (gameState === "ready") {
      playSound("ambience", { loop: true, once: true, volume: 0.5 });
    }
  }, [playSound, gameState]);

  return (
    <>
      <div className="h-full grid grid-rows-[auto_1fr_auto] w-full z-10 relative">
        {/* Top Bar */}
        <TopBar />

        <div className="relative flex flex-col items-center justify-center">
          {/* The Whole Wide Universe */}
          <ToastContainer />
          <ActivityStream />
        </div>

        {/* HUD */}
        <ShipHUD />
      </div>

      {/* Sub-screens (trading, ship, messaging, etc..) */}
      <ScreenContainer />

      {/* Other Renderables */}
      <ShipVisor />
      <StarField />
      <Settings />
    </>
  );
};

export default Game;
