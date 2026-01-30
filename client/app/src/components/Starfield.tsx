import { lazy, Suspense, useEffect, useMemo } from "react"

import { motion } from "motion/react"
import type { PerformanceProfile } from "@gradient-bang/starfield"

import { skyboxImages } from "@/assets"
import Splash from "@/assets/images/splash-1.png"
import useGameStore from "@/stores/game"

// Lazy load the starfield component - this keeps all starfield deps out of main bundle
const StarfieldLazy = lazy(() => import("./StarfieldLazy"))

const skyboxImageList = Object.values(skyboxImages)

const StarfieldFallback = () => (
  <div className="absolute h-full inset-0 overflow-hidden bg-background z-(--z-starfield)">
    <img
      src={Splash}
      alt="Splash"
      className="absolute inset-0 w-full h-full object-contain pointer-events-none"
    />
  </div>
)

export const Starfield = () => {
  const settings = useGameStore.use.settings()
  const lookMode = useGameStore.use.lookMode()
  const starfieldReady = useGameStore.use.starfieldReady()
  const setStarfieldReady = useGameStore.use.setStarfieldReady()

  const starfieldConfig = useMemo(() => {
    return {
      imageAssets: skyboxImageList,
    }
  }, [])

  // Blur any focused element when lookMode becomes active
  // This prevents needing to click twice to interact with the starfield
  useEffect(() => {
    if (lookMode && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
  }, [lookMode])

  if (!settings.renderStarfield || !skyboxImageList.length) {
    return <StarfieldFallback />
  }

  return (
    <Suspense fallback={null}>
      <motion.div
        className="absolute inset-0 z-(--z-starfield) overflow-hidden"
        initial={{ opacity: 0 }}
        animate={{ opacity: starfieldReady ? 1 : 0 }}
        transition={{ delay: 1, duration: 2, ease: "easeOut" }}
      >
        <StarfieldLazy
          profile={settings.qualityPreset as PerformanceProfile}
          config={starfieldConfig}
          onCreated={() => {
            console.debug("[STARFIELD] Starfield ready")
            setStarfieldReady(true)
          }}
          lookMode={lookMode}
        />
      </motion.div>
    </Suspense>
  )
}
