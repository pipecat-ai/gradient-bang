import { createRoot } from "react-dom/client";

import { PipecatAppBase } from "@pipecat-ai/voice-ui-kit";

import { AnimatedFrame } from "@/fx/frame";
import { GameProvider } from "@/GameContext";
import { getLocalSettings } from "@/utils/settings";
import { ViewContainer } from "@/views/ViewContainer";

import "./css/index.css";

// @TODO: Rather than apply during instantiation, we should
// modify relevant properties on pipecat client later.
// Currently, the noAudioOutput setting is irreversible!
const Settings = getLocalSettings();

createRoot(document.getElementById("root")!).render(
  <PipecatAppBase
    transportType="smallwebrtc"
    connectParams={{
      webrtcRequestParams: {
        endpoint: "api/offer",
        requestData: { start_on_join: false },
      },
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
      </GameProvider>
    )}
  </PipecatAppBase>
);
