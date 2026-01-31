import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { Starfield } from "@/Starfield"

import "./styles.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Starfield
      debug={true}
      onCreated={() => console.log("Starfield created")}
      onUnsupported={() => console.log("Starfield unsupported")}
      onWarpAnimationStart={() => console.log("Warp animation started")}
      onTargetRest={(target) => console.log("Target rested:", target)}
      onTargetClear={() => console.log("Target cleared")}
      onReady={() => console.log("Starfield ready")}
    />
  </StrictMode>
)
