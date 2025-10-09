import { AutoPilot } from "@/components/AutoPilot";
import { StarField } from "@/components/StarField";
import { Settings } from "@/dialogs/Settings";
import { usePlaySound } from "@/hooks/usePlaySound";
import { ShipHUD } from "@hud/ShipHUD";
import { TopBar } from "@hud/TopBar";
import { useEffect } from "react";

export const Game = () => {
  const playSound = usePlaySound();

  useEffect(() => {
    playSound("ambience", { loop: true, once: true });
  }, [playSound]);

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
      <StarField />
      <Settings />
    </>
  );
};

export default Game;
