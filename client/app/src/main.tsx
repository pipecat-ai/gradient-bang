import { lazy, StrictMode, Suspense } from "react"
import { createRoot } from "react-dom/client"

import { PipecatClient } from "@pipecat-ai/client-js"
import { PipecatClientProvider } from "@pipecat-ai/client-react"

import { FullScreenLoader } from "@/components/FullScreenLoader"
import { TempMobileBlock } from "@/components/TempMobileBlock"
import { Error } from "@/components/views/Error"
import { ViewContainer } from "@/components/views/ViewContainer"
import { AnimatedFrame } from "@/fx/frame"
import { GameProvider } from "@/GameContext"
import usePipecatClientStore from "@/stores/client"
import useGameStore from "@/stores/game"

import "./css/index.css"

import "./sw-update"

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

console.debug(
  "Gradient Bang Version " + import.meta.env.VITE_APP_VERSION,
  "color: black; font-weight: bold"
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
    {maintenanceMode ?
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          width: "100vw",
          backgroundColor: "#000",
          color: "#fff",
          fontFamily: "monospace",
          textAlign: "center",
          padding: "2rem",
        }}
      >
        <h1 style={{ fontSize: "2rem", marginBottom: "1rem" }}>Maintenance Mode</h1>
        <p style={{ fontSize: "1.2rem", opacity: 0.7 }}>
          Gradient Bang is currently undergoing maintenance. Please check back soon.
        </p>
      </div>
    : isFirefox ?
      <Error noButton title="Firefox Not Support">
        We're sorry, your browser is not currently supported. Gradient Bang relies on advanced web
        technologies that are best supported in Chromium-based browsers like Chrome and Edge, or
        Safari on macOS. Please switch to a supported browser for the best experience.
      </Error>
    : <>
        <Suspense fallback={<FullScreenLoader />}>
          <App />
        </Suspense>

        {/* HOC renderables */}
        <AnimatedFrame />
        {Settings.showMobileWarning && <TempMobileBlock />}
      </>
    }
  </StrictMode>
)
