import { useCallback } from "react"
import { createRoot } from "react-dom/client"

import { useSceneChange } from "@/hooks/useSceneChange"
import { Starfield } from "@/Starfield"

import type { PositionedGameObject } from "./types"

import "./styles.css"

export const App = () => {
  const { changeScene } = useSceneChange()

  const onReady = useCallback(() => {
    console.log("Starfield ready, calling scene change")
    changeScene({
      id: "1",
      gameObjects: [],
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
      gameObjects={[
        {
          id: "port-1",
          type: "port",
          label: "bbs",
        },
      ]}
    />
  )
}

createRoot(document.getElementById("root")!).render(<App />)
