import { usePipecatClient } from "@pipecat-ai/client-react";
import { usePipecatConnectionState } from "@pipecat-ai/voice-ui-kit";

import useGameStore from "@/stores/game";
import { ShipHUD } from "@hud/ShipHUD";
import { TopBar } from "@hud/TopBar";
import { useEffect } from "react";
import { Connect } from "../components/Connect";
import { StarField } from "../components/StarField";
import { usePlaySound } from "../hooks/usePlaySound";

export const Game = ({ onConnect }: { onConnect?: () => void }) => {
  const { isConnected } = usePipecatConnectionState();
  const playSound = usePlaySound();
  const client = usePipecatClient();

  const { startMuted } = useGameStore.use.settings();

  useEffect(() => {
    if (client) {
      if (client.state !== "initialized" && !startMuted) {
        client.initDevices();
      }
    }
  }, [client, startMuted]);

  useEffect(() => {
    if (isConnected) {
      // Play ambient background music
      playSound("ambience", { volume: 0.5, loop: true });
    }
  }, [isConnected, playSound]);

  return (
    <>
      <div className="min-h-screen grid grid-rows-[auto_1fr_auto] w-full z-10 relative">
        {/* Top Bar */}
        <TopBar />

        <div className="flex flex-col items-center justify-center">
          {!isConnected && <Connect onConnect={onConnect!} />}

          {/* HUD Panels */}
        </div>

        {/* Main Game UI */}
        <main className="flex flex-row p-2 pt-0 h-ui mt-auto ">
          <ShipHUD />
        </main>
      </div>

      {/* Other Renderables */}
      <StarField />
    </>
  );
};

export default Game;
