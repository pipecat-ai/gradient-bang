import { useEffect } from "react"

import { Settings } from "@/components/dialogs/Settings"
import { ScreenContainer } from "@/components/screens/ScreenContainer"
import { ToastContainer } from "@/components/toasts/ToastContainer"
import { useNotificationSound } from "@/hooks/useNotificationSound"
import { usePlaySound } from "@/hooks/usePlaySound"
import { ActivityStream } from "@/hud/ActivityStream"
import { ShipHUD } from "@/hud/ShipHUD"
import { ShipVisor } from "@/hud/ShipVisor"
import { Starfield } from "@/hud/StarField"
import { TopBar } from "@/hud/TopBar"
import useGameStore from "@/stores/game"

export const Game = () => {
  const { playSound } = usePlaySound()
  const gameState = useGameStore.use.gameState()

  useNotificationSound()

  useEffect(() => {
    if (gameState === "ready") {
      playSound("ambience", { loop: true, once: true, volume: 0.5 })
    }
  }, [playSound, gameState])

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
      <Starfield />
      <Settings />
    </>
  )
}

export default Game
