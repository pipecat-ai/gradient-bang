import { createRoot } from "react-dom/client";

import { PipecatAppBase } from "@pipecat-ai/voice-ui-kit";

import { TempMobileBlock } from "@/components/TempMobileBlock";
import { AnimatedFrame } from "@/fx/frame";
import { GameProvider } from "@/GameContext";
import { getLocalSettings } from "@/utils/settings";
import { ViewContainer } from "@/views/ViewContainer";

//@TODO: this fixes lazy loading issues, must fix!
import { DailyTransport } from "@pipecat-ai/daily-transport";

import "./css/index.css";

// @TODO: Rather than apply during instantiation, we should
// modify relevant properties on pipecat client later.
// Currently, the noAudioOutput setting is irreversible!
const Settings = getLocalSettings();

// Parse query string parameters
const queryParams = new URLSearchParams(window.location.search);
const endpoint = queryParams.get("server") || "http://localhost:7860/start";

const requestBodyEntries = [...queryParams.entries()].filter(
  ([key]) => key !== "server"
);
const requestBody = Object.fromEntries(requestBodyEntries) as Record<string, string>;

const startRequestData = {
  createDailyRoom: true,
  dailyRoomProperties: {
    start_video_off: true,
    eject_at_room_exp: true,
  },
  body: requestBody,
};

console.debug("[MAIN] Daily start endpoint:", endpoint, DailyTransport);

createRoot(document.getElementById("root")!).render(
  <PipecatAppBase
    transportType="daily"
    startBotParams={{
      endpoint,
      requestData: startRequestData,
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

        {/* HOC renderables */}
        <AnimatedFrame />
        {Settings.showMobileWarning && <TempMobileBlock />}
      </GameProvider>
    )}
  </PipecatAppBase>
);
