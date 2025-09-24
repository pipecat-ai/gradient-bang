import { usePipecatClient } from "@pipecat-ai/client-react";
import {
  Divider,
  usePipecatConnectionState,
  UserAudioControl,
} from "@pipecat-ai/voice-ui-kit";

import { useEffect } from "react";

import { usePlaySound } from "../hooks/usePlaySound";
import { AutoPilot } from "./HUD/AutoPilot";
import { Bar } from "./HUD/Bar";
import { Connect } from "./HUD/Connect";
import { LHS } from "./HUD/LHS";
import { RHS } from "./HUD/RHS";
import { HighlightOverlay } from "./HighlightOverlay";
import { ImagePanel } from "./ImagePanel";
import { StarField } from "./StarField";
import { PortPanel } from "./panels/PortPanel";

export const App = ({ onConnect }: { onConnect?: () => void }) => {
  const { isConnected } = usePipecatConnectionState();
  const playSound = usePlaySound();
  const client = usePipecatClient();
  useEffect(() => {
    if (client && client.state !== "initialized") {
      client.initDevices();
    }
  }, [client]);

  useEffect(() => {
    if (isConnected) {
      playSound("ambience", { volume: 0.5, loop: true });
    }
  }, [isConnected, playSound]);

  return (
    <>
      <div className="min-h-screen grid grid-rows-[auto_1fr_auto] w-full z-90 relative">
        {/* Top Bar */}
        <Bar />

        {/* Ship HUD */}
        <div className="flex flex-col items-center justify-center">
          {!isConnected && <Connect onConnect={onConnect!} />}
          {/* HUD Panels */}
          <AutoPilot />
          <PortPanel />
        </div>

        {/* Main Game UI*/}
        <main className="flex flex-row items-end gap-4 p-2 pt-0 mt-auto">
          <div className="flex-1 self-stretch min-w-[320px]">
            <LHS />
          </div>
          <div
            className="flex flex-col gap-2 shadow-xlong relative self-end"
            style={{ height: "var(--height-ui)" }}
          >
            <div className="dotted-frame absolute -left-20 -right-20 -top-10 bottom-0" />
            <ImagePanel />
            <Divider className="w-full py-1.5" variant="dotted" />
            <UserAudioControl size="lg" variant="outline" />
          </div>
          <div
            style={{ height: "var(--height-ui)" }}
            className="w-full self-end"
          >
            <RHS />
          </div>
        </main>
      </div>
      <StarField />
      <HighlightOverlay />
    </>
  );
};
