import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { Leva } from "leva"
import { PipecatAppBase } from "@pipecat-ai/voice-ui-kit"

import { TempMobileBlock } from "@/components/TempMobileBlock"
import { ViewContainer } from "@/components/views/ViewContainer"
import { AnimatedFrame } from "@/fx/frame"
import { GameProvider } from "@/GameContext"
import useGameStore from "@/stores/game"

import "./css/index.css"

// Get settings from the initialized store (not from JSON directly)
const Settings = useGameStore.getState().settings

// Parse query string parameters
const queryParams = new URLSearchParams(window.location.search)
const transport =
  queryParams.get("transport") ||
  import.meta.env.VITE_PIPECAT_TRANSPORT ||
  "smallwebrtc"

const endpoint =
  (queryParams.get("server") ||
    import.meta.env.VITE_SERVER_URL ||
    "http://localhost:54321/functions/v1") + "/start"

useGameStore.getState().setBotConfig(
  {
    endpoint,
  },
  transport as "smallwebrtc" | "daily"
)

console.debug("[MAIN] Pipecat Configuration:", endpoint, transport)

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PipecatAppBase
      transportType={transport as "smallwebrtc" | "daily"}
      clientOptions={{
        enableMic: Settings.enableMic,
      }}
      noThemeProvider={true}
      noAudioOutput={Settings.disableRemoteAudio}
      initDevicesOnMount={false}
      transportOptions={{
        offerUrlTemplate: `${import.meta.env.VITE_SERVER_URL || "http://localhost:54321/functions/v1"}/start/:sessionId/api/offer`,
      }}
    >
      {({ handleConnect, error }) => (
        <GameProvider onConnect={handleConnect}>
          <ViewContainer error={error} />
        </GameProvider>
      )}
    </PipecatAppBase>

    {/* HOC renderables */}
    <AnimatedFrame />
    {Settings.showMobileWarning && <TempMobileBlock />}

    {import.meta.env.DEV && <Leva collapsed hidden={!Settings.useDevTools} />}
  </StrictMode>
)
