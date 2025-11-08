import { createRoot } from "react-dom/client";

import { PipecatAppBase } from "@pipecat-ai/voice-ui-kit";

import { TempMobileBlock } from "@/components/TempMobileBlock";
import { GameProvider } from "@/GameContext";
import { ViewContainer } from "@/views/ViewContainer";
import { AnimatedFrame } from "@fx/frame";
import useGameStore from "@stores/game";

import "./css/index.css";

// Get settings from the initialized store (not from JSON directly)
const Settings = useGameStore.getState().settings;

// Parse query string parameters
const queryParams = new URLSearchParams(window.location.search);
const transport = queryParams.get("transport") || "smallwebrtc";
const endpoint = queryParams.get("server") || "api/offer";

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
  body: requestBody,
};

console.debug("[MAIN] Pipecat Configuration:", endpoint, transport);

createRoot(document.getElementById("root")!).render(
  <>
    <PipecatAppBase
      transportType={transport as "smallwebrtc" | "daily"}
      startBotParams={{
        endpoint,
        requestData:
          transport === "daily" ? startRequestData : { start_on_join: false },
      }}
      clientOptions={{
        enableMic: Settings.enableMic,
      }}
      noThemeProvider={true}
      noAudioOutput={Settings.disableRemoteAudio}
    >
      {({ handleConnect, error }) => (
        <GameProvider onConnect={handleConnect}>
          {/* Main View Container */}
          <ViewContainer error={error} />
        </GameProvider>
      )}
    </PipecatAppBase>
    {/* HOC renderables */}
    <AnimatedFrame />
    {Settings.showMobileWarning && <TempMobileBlock />}
  </>
);
