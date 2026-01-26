import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { Leva } from "leva"
import { PipecatClient } from "@pipecat-ai/client-js"
import { PipecatClientProvider } from "@pipecat-ai/client-react"
import { DailyTransport } from "@pipecat-ai/daily-transport"
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport"

import { TempMobileBlock } from "@/components/TempMobileBlock"
import Error from "@/components/views/Error"
import { ViewContainer } from "@/components/views/ViewContainer"
import { AnimatedFrame } from "@/fx/frame"
import { GameProvider } from "@/GameContext"
import usePipecatClientStore from "@/stores/client"
import useGameStore from "@/stores/game"

import "./css/index.css"

// Get settings from the initialized store (not from JSON directly)
const Settings = useGameStore.getState().settings

// Parse query string parameters
const queryParams = new URLSearchParams(window.location.search)
const transport =
  queryParams.get("transport") || import.meta.env.VITE_PIPECAT_TRANSPORT || "smallwebrtc"

const endpoint =
  (queryParams.get("server") || Settings.bypassTitle ?
    import.meta.env.VITE_BOT_URL || "http://localhost:7860"
  : import.meta.env.VITE_SERVER_URL || "http://localhost:54321/functions/v1") + "/start"

useGameStore.getState().setBotConfig(
  {
    endpoint,
  },
  transport as "smallwebrtc" | "daily"
)

console.debug("[MAIN] Pipecat Configuration:", endpoint, transport)

export const App = () => {
  const client = usePipecatClientStore((state) => state.client)
  const setClient = usePipecatClientStore((state) => state.setClient)
  const error = usePipecatClientStore((state) => state.error)

  if (!client) {
    if (transport === "smallwebrtc") {
      const client = new PipecatClient({
        transport: new SmallWebRTCTransport({
          offerUrlTemplate: `${
            import.meta.env.VITE_SERVER_URL || "http://localhost:54321/functions/v1"
          }/start/:sessionId/api/offer`,
        }),
      })
      setClient(client)
    } else {
      const client = new PipecatClient({
        transport: new DailyTransport(),
      })

      setClient(client)
    }
  }

  if (!client) {
    return <></>
  }

  if (error) {
    return <Error onRetry={() => client.startBotAndConnect({ endpoint })}>{error}</Error>
  }

  return (
    <PipecatClientProvider client={client}>
      <GameProvider>
        <ViewContainer error={error} />
      </GameProvider>
    </PipecatClientProvider>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />

    {/* HOC renderables */}
    <AnimatedFrame />
    {Settings.showMobileWarning && <TempMobileBlock />}

    {import.meta.env.DEV && <Leva collapsed hidden={!Settings.useDevTools} />}
  </StrictMode>
)
