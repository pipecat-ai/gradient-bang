import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { Starfield } from "@/Starfield.tsx"

import "./styles.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Starfield
      config={{ vignette: { vignetteEnabled: false } }}
      onCreated={() => console.log("Starfield created")}
      onUnsupported={() => console.log("Starfield unsupported")}
    />
  </StrictMode>
)
