import { lazy, StrictMode, Suspense } from "react"
import { createRoot } from "react-dom/client"

import { PipecatClient } from "@pipecat-ai/client-js"
import { PipecatClientProvider } from "@pipecat-ai/client-react"

import { LandingPage } from "@/components/LandingPage"
import { SuspenseLoader } from "@/components/SuspenseLoader"
import { Error } from "@/components/views/Error"
import { ViewContainer } from "@/components/views/ViewContainer"
import { AnimatedFrame } from "@/fx/frame"
import { GameProvider } from "@/GameContext"
import usePipecatClientStore from "@/stores/client"
import useGameStore from "@/stores/game"

import { swReady } from "./sw-update"

import "./css/index.css"

const isFirefox = /firefox/i.test(navigator.userAgent)

const maintenanceMode =
  import.meta.env.VITE_MAINTENANCE_MODE && import.meta.env.VITE_MAINTENANCE_MODE !== "0"

// Prevent browser-level zoom (Ctrl/Cmd +/-, Ctrl/Cmd scroll, pinch)
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "+" || e.key === "-" || e.key === "=")) {
    e.preventDefault()
  }
})
document.addEventListener(
  "wheel",
  (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
    }
  },
  { passive: false }
)

// Parse query string parameters
const queryParams = new URLSearchParams(window.location.search)
const transport =
  queryParams.get("transport") || import.meta.env.VITE_PIPECAT_TRANSPORT || "smallwebrtc"

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

console.debug(
  "%cGradient Bang Version " + import.meta.env.VITE_APP_VERSION,
  "background: #90EE90; color: #006400; font-weight: bold"
)
console.debug(
  "%c[GAME INIT] Pipecat Configuration",
  "color: orange; font-weight: bold",
  endpoint,
  transport
)

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
        return new DailyTransport({ startAudioOff: true })
      }

  // Wait for SW update check and transport creation in parallel.
  // FullScreenLoader stays visible until both complete.
  const [, transportInstance] = await Promise.all([swReady, createTransport()])

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
    {maintenanceMode ?
      <LandingPage />
    : <>
        {isFirefox && (
          <Error title="Firefox Detected" buttonLabel="Understood, proceed anyway">
            Firefox is not recommended due to WebRTC compatibility issues and limited testing. For
            the best experience, please use a Chromium-based browser like Chrome, or Safari on
            macOS.
          </Error>
        )}
        <Suspense fallback={<SuspenseLoader />}>
          <App />
        </Suspense>

        {/* HOC renderables */}
        <AnimatedFrame />
      </>
    }
  </StrictMode>
)
