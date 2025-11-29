import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { Starfield } from "@/Starfield"

import "./styles.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Starfield
      onCreated={() => console.log("Starfield created")}
      onUnsupported={() => console.log("Starfield unsupported")}
      config={{ planet: { scale: 100 } }}
    />
  </StrictMode>
)
