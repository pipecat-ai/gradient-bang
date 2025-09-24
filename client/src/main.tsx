import { createRoot } from "react-dom/client";

import { logger, LogLevel } from "@pipecat-ai/client-js";
import { PipecatAppBase } from "@pipecat-ai/voice-ui-kit";

import { App } from "./components/App";
import { Error } from "./components/Error";
import { GameProvider } from "./GameContext";
import { UIProvider } from "./UIContext";

import "./css/index.css";
import "./utils/console-api";

const configuredLevel = import.meta.env.VITE_PIPECAT_LOG_LEVEL as keyof typeof LogLevel | undefined;
const logLevel = configuredLevel && LogLevel[configuredLevel] !== undefined
  ? LogLevel[configuredLevel]
  : LogLevel.WARN;

logger.setLevel(logLevel);

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
