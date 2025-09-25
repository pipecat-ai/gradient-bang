import { usePipecatClient } from "@pipecat-ai/client-react";
import { Button, usePipecatConnectionState } from "@pipecat-ai/voice-ui-kit";

import { Debug } from "@hud/Debug";
import { SectorMap } from "@hud/SectorMap";
import { TopBar } from "@hud/TopBar";
import { useEffect } from "react";
import { Connect } from "../components/HUD/Connect";
import { PortBadge } from "../components/PortBadge";
import { SectorBadge } from "../components/SectorBadge";
import Starfield from "../components/Starfield";
import { usePlaySound } from "../hooks/usePlaySound";
import { useSettingsStore } from "../stores/settings";

export const Game = ({ onConnect }: { onConnect?: () => void }) => {
  const { isConnected } = usePipecatConnectionState();
  const playSound = usePlaySound();
  const client = usePipecatClient();

  const startMuted = useSettingsStore.use.startMuted();

  useEffect(() => {
    if (client && client.state !== "initialized" && !startMuted) {
      client.initDevices();
    }
  }, [client, startMuted]);

  useEffect(() => {
    if (isConnected) {
      playSound("ambience", { volume: 0.5, loop: true });
    }
  }, [isConnected, playSound]);

  return (
    <>
      <div className="min-h-screen grid grid-rows-[auto_1fr_auto] w-full z-90 relative">
        {/* Top Bar */}
        <TopBar />

        <div className="flex flex-col items-center justify-center">
          {!isConnected && <Connect onConnect={onConnect!} />}

          {/* HUD Panels */}
        </div>

        {/* Main Game UI */}
        <main className="flex flex-row p-2 pt-0 h-ui mt-auto ">
          <SectorBadge />
          <PortBadge />
          <SectorMap />
          <Button
            onClick={() => {
              client?.sendClientMessage("get-my-status");
            }}
          >
            Get My Status
          </Button>
          <Button
            onClick={() => {
              client?.sendClientMessage("move-to-sector", { sector: 0 });
            }}
          >
            Move to sector 0
          </Button>
        </main>
      </div>

      {/* Other Renderables */}
      <Starfield />
      <Debug />
    </>
  );
};

export default Game;
