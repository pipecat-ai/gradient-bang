import { createRoot } from "react-dom/client";

import {
  FullScreenContainer,
  PipecatAppBase,
  StripeLoader,
} from "@pipecat-ai/voice-ui-kit";

import { App } from "./components/App";
import { Error } from "./components/Error";
import { GameProvider } from "./GameContext";
import { UIProvider } from "./UIContext";

import "./index.css";

createRoot(document.getElementById("root")!).render(
  <PipecatAppBase
    connectParams={{
      webrtcUrl: "/api/offer",
    }}
    transportType="smallwebrtc"
    themeProps={{ defaultTheme: "dark" }}
  >
    {({ client, handleConnect, error }) =>
      !client ? (
        // Await for the client and JS to initialize
        <FullScreenContainer>
          <StripeLoader />
        </FullScreenContainer>
      ) : error ? (
        <Error onRetry={handleConnect}>{error}</Error>
      ) : (
        <GameProvider>
          <UIProvider>
            <App onConnect={handleConnect} />
          </UIProvider>
        </GameProvider>
      )
    }
  </PipecatAppBase>
);
