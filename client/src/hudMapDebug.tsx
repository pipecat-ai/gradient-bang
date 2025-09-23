import React from "react";
import { createRoot } from "react-dom/client";

import "./css/index.css";
import HudMapDebugHarness from "./HudMapDebugHarness";

const container = document.getElementById("root");

if (!container) {
  throw new Error("hud-map-debug: #root container not found");
}

const root = createRoot(container);

root.render(
  <React.StrictMode>
    <HudMapDebugHarness />
  </React.StrictMode>
);
