import { lazy, Suspense, useCallback, useEffect, useMemo } from "react"

import { motion } from "motion/react"
import type { PerformanceProfile } from "@gradient-bang/starfield"

import { portImages, skyboxImages } from "@/assets"
import Splash from "@/assets/images/splash-1.png"
import useGameStore from "@/stores/game"

// Lazy load the starfield component - this keeps all starfield deps out of main bundle
const StarfieldLazy = lazy(() => import("./StarfieldLazy"))

const skyboxImageList = Object.values(skyboxImages)
const portImageList = Object.values(portImages)

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
  // Use specific selectors to prevent re-renders from unrelated state changes
  const renderStarfield = useGameStore((state) => state.settings.renderStarfield)
  const qualityPreset = useGameStore((state) => state.settings.qualityPreset)
  const lookMode = useGameStore.use.lookMode()
  const starfieldReady = useGameStore.use.starfieldReady()
  const setStarfieldReady = useGameStore.use.setStarfieldReady()
  const lookAtTarget = useGameStore.use.lookAtTarget()
  const activePanel = useGameStore.use.activePanel?.()

  useEffect(() => {
    if (!useGameStore.getState().starfieldReady) return

    if (activePanel === "trade") {
      const sector = useGameStore.getState().sector
      if (sector?.port) {
        useGameStore.getState().setLookAtTarget("port-" + sector?.id.toString())
      }
    } else {
      useGameStore.getState().setLookAtTarget(undefined)
    }
  }, [activePanel])

  const starfieldConfig = useMemo(() => {
    return {
      imageAssets: [
        ...skyboxImageList.map((url) => ({ type: "skybox" as const, url })),
        ...portImageList.map((url) => ({ type: "port" as const, url })),
      ],
    }
  }, [])

  // Stable callback reference - setStarfieldReady is from zustand so it's stable
  const handleCreated = useCallback(() => {
    console.debug("[STARFIELD] Starfield created")
    setStarfieldReady(true)
  }, [setStarfieldReady])

  const handleSceneChangeEnd = useCallback(() => {
    const ap = useGameStore.getState().activePanel
    if (ap === "trade") {
      const sector = useGameStore.getState().sector
      if (sector?.port) {
        useGameStore.getState().setLookAtTarget("port-" + sector?.id.toString())
      }
    } else {
      useGameStore.getState().setLookAtTarget(undefined)
    }
  }, [])

  // Blur any focused element when lookMode becomes active
  // This prevents needing to click twice to interact with the starfield
  useEffect(() => {
    if (lookMode && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
  }, [lookMode])

  if (!renderStarfield || !skyboxImageList.length) {
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
          debug={false}
          lookMode={lookMode}
          lookAtTarget={lookAtTarget}
          profile={qualityPreset as PerformanceProfile}
          config={starfieldConfig}
          onCreated={handleCreated}
          onSceneChangeEnd={handleSceneChangeEnd}
        />
      </motion.div>
    </Suspense>
  )
}
