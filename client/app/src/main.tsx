import { lazy, StrictMode, Suspense } from "react"
import { createRoot } from "react-dom/client"

import { PipecatClient } from "@pipecat-ai/client-js"
import { PipecatClientProvider } from "@pipecat-ai/client-react"

import { TempMobileBlock } from "@/components/TempMobileBlock"
import { Error } from "@/components/views/Error"
import { ViewContainer } from "@/components/views/ViewContainer"
import { AnimatedFrame } from "@/fx/frame"
import { GameProvider } from "@/GameContext"
import usePipecatClientStore from "@/stores/client"
import useGameStore from "@/stores/game"

import { FullScreenLoader } from "./components/FullScreenLoader"

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

const App = lazy(async () => {
  const createTransport =
    transport === "smallwebrtc" ?
      async () => {
        const { SmallWebRTCTransport } = await import("@pipecat-ai/small-webrtc-transport")
        return new SmallWebRTCTransport({
          offerUrlTemplate: `${
            import.meta.env.VITE_SERVER_URL || "http://localhost:54321/functions/v1"
          }/start/:sessionId/api/offer`,
        })
      }
    : async () => {
        const { DailyTransport } = await import("@pipecat-ai/daily-transport")
        return new DailyTransport()
      }

  const transportInstance = await createTransport()

  const AppComponent = () => {
    const client = usePipecatClientStore((state) => state.client)
    const setClient = usePipecatClientStore((state) => state.setClient)
    const error = usePipecatClientStore((state) => state.error)

    if (!client) {
      const newClient = new PipecatClient({
        transport: transportInstance,
      })
      setClient(newClient)
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

  return { default: AppComponent }
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={<FullScreenLoader />}>
      <App />
    </Suspense>

    {/* HOC renderables */}
    <AnimatedFrame />
    {Settings.showMobileWarning && <TempMobileBlock />}
  </StrictMode>
)
