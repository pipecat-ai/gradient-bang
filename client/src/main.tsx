import { createRoot } from "react-dom/client";

import { PipecatAppBase } from "@pipecat-ai/voice-ui-kit";

import { GameProvider } from "@/GameContext";
import { getLocalSettings } from "@/utils/settings";
import Error from "@views/Error";
import Game from "@views/Game";

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
    {({ handleConnect, error }) =>
      error ? (
        <Error onRetry={handleConnect}>{error}</Error>
      ) : (
        <GameProvider>
          <Game onConnect={handleConnect} />
        </GameProvider>
      )
    }
  </PipecatAppBase>
);
