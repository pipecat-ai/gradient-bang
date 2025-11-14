import { useEffect } from "react"

import { Settings } from "@/components/dialogs/Settings"
import { ScreenContainer } from "@/components/screens/ScreenContainer"
import { ToastContainer } from "@/components/toasts/ToastContainer"
import { useNotificationSound } from "@/hooks/useNotificationSound"
import { usePlaySound } from "@/hooks/usePlaySound"
import useGameStore from "@/stores/game"
import { ActivityStream } from "@hud/ActivityStream"
import { ShipHUD } from "@hud/ShipHUD"
import { ShipVisor } from "@hud/ShipVisor"
import { StarField } from "@hud/StarField"
import { TopBar } from "@hud/TopBar"

export const Game = () => {
  const { playSound } = usePlaySound()
  const gameState = useGameStore.use.gameState()

  useNotificationSound()

  useEffect(() => {
    if (gameState === "ready") {
      playSound("ambience", { loop: true, once: true, volume: 0.5 })
    }
  }, [playSound, gameState])

  useEffect(() => {
    const handleKeyPress = (event: KeyboardEvent) => {
      if (event.key === "p" || event.key === "P") {
        const sector = useGameStore.getState().sector
        if (sector?.port) {
          const starfieldInstance = useGameStore.getState().starfieldInstance
          if (starfieldInstance) {
            starfieldInstance.selectGameObject("port")
          }
        }
      }
      if (event.key === "c" || event.key === "c") {
        const starfieldInstance = useGameStore.getState().starfieldInstance
        if (starfieldInstance) {
          starfieldInstance.clearGameObjectSelection()
        }
      }
    }

    window.addEventListener("keydown", handleKeyPress)
    return () => window.removeEventListener("keydown", handleKeyPress)
  }, [])

  return (
    <>
      <div className="h-full grid grid-rows-[auto_1fr_auto] w-full z-10 relative">
        {/* Top Bar */}
        <TopBar />

        <div className="relative flex flex-col items-center justify-center">
          {/* The Whole Wide Universe */}
          <ToastContainer />
          <ActivityStream />
        </div>

        {/* HUD */}
        <ShipHUD />
      </div>

      {/* Sub-screens (trading, ship, messaging, etc..) */}
      <ScreenContainer />

      {/* Other Renderables */}
      <ShipVisor />
      <StarField />
      <Settings />
    </>
  )
}

export default Game
