import { createRoot } from "react-dom/client";

import { PipecatAppBase } from "@pipecat-ai/voice-ui-kit";

import { TempMobileBlock } from "@/components/TempMobileBlock";
import { AnimatedFrame } from "@/fx/frame";
import { GameProvider } from "@/GameContext";
import { getLocalSettings } from "@/utils/settings";
import { ViewContainer } from "@/views/ViewContainer";

//@TODO: this fixes lazy loading issues, must fix!
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";

import "./css/index.css";

// @TODO: Rather than apply during instantiation, we should
// modify relevant properties on pipecat client later.
// Currently, the noAudioOutput setting is irreversible!
const Settings = getLocalSettings();

// Parse query string parameters
const queryParams = new URLSearchParams(window.location.search);
const endpoint = queryParams.get("server") || "api/offer";

console.debug("[MAIN] Custom endpoint:", endpoint, SmallWebRTCTransport);

createRoot(document.getElementById("root")!).render(
  <PipecatAppBase
    transportType="smallwebrtc"
    connectParams={{
      webrtcRequestParams: {
        endpoint: endpoint,
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
        {Settings.showMobileWarning && <TempMobileBlock />}
      </GameProvider>
    )}
  </PipecatAppBase>
);
