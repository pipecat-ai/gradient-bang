import { createRoot } from "react-dom/client";

import { PipecatAppBase } from "@pipecat-ai/voice-ui-kit";

import { GameProvider } from "./GameContext";

import Error from "./state/Error";
import Game from "./state/Game";

import "./css/index.css";

createRoot(document.getElementById("root")!).render(
  <PipecatAppBase
    connectParams={{
      webrtcUrl: "/api/offer",
    }}
    transportType="smallwebrtc"
    noThemeProvider={true}
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
