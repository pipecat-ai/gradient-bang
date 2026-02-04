import { useCallback } from "react"
import { createRoot } from "react-dom/client"

import { useSceneChange } from "@/hooks/useSceneChange"
import { Starfield } from "@/Starfield"

import type { PositionedGameObject } from "./types"

import "./styles.css"

const TEST_CONFIG = {
  imageAssets: [
    { type: "skybox", url: "/test-skybox-1.png" },
    { type: "skybox", url: "/test-skybox-2.png" },
    { type: "port", url: "/test-port-1.png" },
    { type: "port", url: "/test-port-2.png" },
    { type: "port", url: "/test-port-3.png" },
  ],
}
export const App = () => {
  const { changeScene } = useSceneChange()

  const onReady = useCallback(() => {
    console.log("Starfield ready, calling scene change")
    changeScene({
      id: "1",
      gameObjects: [
        {
          id: "port-1",
          type: "port",
          label: "bbs",
        },
      ],
      config: {
        palette: "cosmicTeal",
      },
    })
  }, [changeScene])

  const onSceneChangeStart = useCallback(() => {
    console.log("Scene change started")
  }, [])
  const onSceneChangeEnd = useCallback(() => {
    console.log("Scene change ended")
  }, [])
  const onTargetRest = useCallback((target: PositionedGameObject) => {
    console.log("Target rested:", target)
  }, [])

  const onTargetClear = useCallback(() => {
    console.log("Target cleared")
  }, [])

  const onUnsupported = useCallback(() => {
    console.log("Starfield unsupported")
  }, [])

  const onCreated = useCallback(() => {
    console.log("Starfield created")
  }, [])

  return (
    <Starfield
      debug={true}
      onCreated={onCreated}
      onUnsupported={onUnsupported}
      onSceneChangeStart={onSceneChangeStart}
      onSceneChangeEnd={onSceneChangeEnd}
      onTargetRest={onTargetRest}
      onTargetClear={onTargetClear}
      onReady={onReady}
      config={TEST_CONFIG}
    />
  )
}

createRoot(document.getElementById("root")!).render(<App />)
