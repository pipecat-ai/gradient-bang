import { createRoot } from "react-dom/client";

import { PipecatAppBase } from "@pipecat-ai/voice-ui-kit";

import { App } from "./components/App";
import { Error } from "./components/Error";
import { GameProvider } from "./GameContext";
import { UIProvider } from "./UIContext";

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
        <UIProvider>
          <GameProvider>
            <App onConnect={handleConnect} />
          </GameProvider>
        </UIProvider>
      )
    }
  </PipecatAppBase>
);
