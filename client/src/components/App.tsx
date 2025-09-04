import { usePipecatClient } from "@pipecat-ai/client-react";
import {
  Divider,
  usePipecatConnectionState,
  UserAudioControl,
} from "@pipecat-ai/voice-ui-kit";

import { useEffect, useState } from "react";

import { usePlaySound } from "../hooks/usePlaySound";
import { Bar } from "./HUD/Bar";
import { Connect } from "./HUD/Connect";
import { LHS } from "./HUD/LHS";
import { RHS } from "./HUD/RHS";
import { HighlightOverlay } from "./HighlightOverlay";
import { ImagePanel } from "./ImagePanel";
import { type PanelMenuItem } from "./PanelMenu";
import { StarField } from "./StarField";
import { PortPanel } from "./panels/PortPanel";

export const App = ({ onConnect }: { onConnect?: () => void }) => {
  const { isConnected } = usePipecatConnectionState();
  const playSound = usePlaySound();
  const client = usePipecatClient();
  const [currentPanel, setCurrentPanel] =
    useState<PanelMenuItem>("task_output");

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
          <PortPanel />
        </div>

        {/* Main Game UI*/}
        <main className="flex flex-row p-5 pt-0 h-ui mt-auto ">
          <LHS />
          <div className="flex flex-col gap-2 shadow-xlong relative">
            <div className="dotted-frame absolute -left-20 -right-20 -top-10 bottom-0" />
            <ImagePanel />
            <Divider className="w-full py-1.5" variant="dotted" />
            <UserAudioControl size="lg" variant="outline" />
          </div>
          <RHS />
        </main>
      </div>
      <StarField />
      <HighlightOverlay />
    </>
  );
};
