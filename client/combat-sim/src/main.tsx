import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "./App"
import { ApiKeyGate } from "./components/ApiKeyGate"

import "./index.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ApiKeyGate>
      <App />
    </ApiKeyGate>
  </StrictMode>,
)
