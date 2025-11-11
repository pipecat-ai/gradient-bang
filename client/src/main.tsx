import { PipecatAppBase } from "@pipecat-ai/voice-ui-kit";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { TempMobileBlock } from "@/components/TempMobileBlock";
import { ViewContainer } from "@/components/views/ViewContainer";
import { GameProvider } from "@/GameContext";
import { AnimatedFrame } from "@fx/frame";
import useGameStore from "@stores/game";

import "./css/index.css";

// Get settings from the initialized store (not from JSON directly)
const Settings = useGameStore.getState().settings;

// Parse query string parameters
const queryParams = new URLSearchParams(window.location.search);
const transport = queryParams.get("transport") || "smallwebrtc";
const endpoint =
  queryParams.get("server") || `${import.meta.env.VITE_BOT_URL}/start`;

const requestBodyEntries = [...queryParams.entries()].filter(
  ([key]) => key !== "server" && key !== "transport"
);
const requestBody = Object.fromEntries(requestBodyEntries) as Record<
  string,
  string
>;
const startRequestData = {
  createDailyRoom: true,
  dailyRoomProperties: {
    start_video_off: true,
    eject_at_room_exp: true,
  },
  body: { ...requestBody, start_on_join: false },
};

// createDailyRoom: false, enableDefaultIceServers: true

console.debug("[MAIN] Pipecat Configuration:", endpoint, transport);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PipecatAppBase
      startBotParams={{
        endpoint,
        requestData:
          transport === "daily"
            ? startRequestData
            : { ...requestBody, start_on_join: false },
      }}
      transportType={transport as "smallwebrtc" | "daily"}
      clientOptions={{
        enableMic: Settings.enableMic,
      }}
      noThemeProvider={true}
      noAudioOutput={Settings.disableRemoteAudio}
    >
      {({ handleConnect, error }) => (
        <GameProvider onConnect={handleConnect}>
          <ViewContainer error={error} />
        </GameProvider>
      )}
    </PipecatAppBase>
    {/* HOC renderables */}
    <AnimatedFrame />
    {Settings.showMobileWarning && <TempMobileBlock />}
  </StrictMode>
);
