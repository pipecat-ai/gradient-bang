import { createRoot } from "react-dom/client";

import { PipecatAppBase } from "@pipecat-ai/voice-ui-kit";

import { GameProvider } from "./GameContext";

import Error from "@state/Error";
import Game from "@state/Game";

import Settings from "./settings.json";

import "./css/index.css";

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
    noAudioOutput={Settings.disableAudioOutput}
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
