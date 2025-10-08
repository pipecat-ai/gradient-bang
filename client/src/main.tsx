import { createRoot } from "react-dom/client";

import { PipecatAppBase } from "@pipecat-ai/voice-ui-kit";

import { GameProvider } from "@/GameContext";
import { getLocalSettings } from "@/utils/settings";

import ViewContainer from "@views/ViewContainer";
import "./css/index.css";

const Settings = getLocalSettings();

createRoot(document.getElementById("root")!).render(
  <PipecatAppBase
    connectParams={{
      webrtcRequestParams: { endpoint: "api/offer" },
    }}
    clientOptions={{
      enableMic: Settings.enableMic,
    }}
    transportType="smallwebrtc"
    noThemeProvider={true}
    noAudioOutput={Settings.disableRemoteAudio}
  >
    {({ handleConnect, error }) => (
      <GameProvider>
        <ViewContainer onConnect={handleConnect} error={error} />
      </GameProvider>
    )}
  </PipecatAppBase>
);
