import { usePipecatClient } from "@pipecat-ai/client-react";
import { usePipecatConnectionState } from "@pipecat-ai/voice-ui-kit";

import Summary from "@/hud/Summary";
import { Debug } from "@hud/Debug";
import { SectorMap } from "@hud/SectorMap";
import { TopBar } from "@hud/TopBar";
import { useCallback, useEffect } from "react";
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

  const sendUserTextInput = useCallback(
    (text: string) => {
      if (!client) {
        console.error("[GAME] Client not available");
        return;
      }
      if (client.state !== "ready") {
        console.error(
          `[GAME] Client not ready. Current state: ${client.state}`
        );
        return;
      }
      console.debug(`[GAME] Sending user text input: "${text}"`);
      client.sendClientMessage("user-text-input", { text });
      console.debug("[GAME] Message sent successfully");
    },
    [client]
  );

  useEffect(() => {
    if (client) {
      if (client.state !== "initialized" && !startMuted) {
        client.initDevices();
      }

      // Attach send user text input function to window object
      (
        window as typeof window & { sendUserTextInput?: (text: string) => void }
      ).sendUserTextInput = sendUserTextInput;
    }
  }, [client, startMuted, sendUserTextInput]);

  useEffect(() => {
    if (isConnected) {
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
          <SectorBadge />
          <PortBadge />
          <SectorMap />
          <Summary />
        </main>
      </div>

      {/* Other Renderables */}
      <Starfield />
      <Debug />
    </>
  );
};

export default Game;
