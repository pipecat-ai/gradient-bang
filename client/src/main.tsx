import { createRoot } from "react-dom/client";

import { PipecatAppBase } from "@pipecat-ai/voice-ui-kit";

import { GameProvider } from "@/GameContext";
import { getLocalSettings } from "@/utils/settings";

import ViewContainer from "@views/ViewContainer";
import "./css/index.css";

// @TODO: Rather than apply during constructor, we should
// modify relevant properties on client later.
// Currently, the noAudioOutput setting is irreversible!
const Settings = getLocalSettings();

createRoot(document.getElementById("root")!).render(
  <PipecatAppBase
    connectParams={{
      webrtcRequestParams: {
        endpoint: "api/offer",
        requestData: { start_on_join: false },
      },
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
