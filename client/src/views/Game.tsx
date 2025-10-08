import { StarField } from "@/components/StarField";
import { usePlaySound } from "@/hooks/usePlaySound";
import { ShipHUD } from "@hud/ShipHUD";
import { TopBar } from "@hud/TopBar";
import { Settings } from "@views/dialogs/Settings";
import { useEffect } from "react";

export const Game = () => {
  const playSound = usePlaySound();

  useEffect(() => {
    playSound("ambience", { loop: true, once: true });
  }, [playSound]);

  return (
    <>
      <div className="min-h-screen grid grid-rows-[auto_1fr_auto] w-full z-10 relative">
        {/* Top Bar */}
        <TopBar />

        <div className="flex flex-col items-center justify-center">
          {/* HUD Panels */}
        </div>

        {/* Main Game UI */}
        <main className="flex flex-row p-2 pt-0 h-ui mt-auto ">
          <ShipHUD />
        </main>
      </div>

      {/* Other Renderables */}
      <StarField />
      <Settings />
    </>
  );
};

export default Game;
