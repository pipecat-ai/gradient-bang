import { lazy, Suspense, useCallback, useEffect, useMemo } from "react"

import { motion } from "motion/react"
import type { PerformanceProfile, PositionedGameObject } from "@gradient-bang/starfield"

import { portImages, skyboxImages } from "@/assets"
import Splash from "@/assets/images/splash-1.png"
import { StarfieldPlayerCard } from "@/components/StarfieldPlayerCard"
import useAudioStore from "@/stores/audio"
import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

// Lazy load the starfield component - this keeps all starfield deps out of main bundle
const StarfieldLazy = lazy(() => import("./StarfieldLazy"))

const skyboxImageList = Object.values(skyboxImages)
const portImageList = Object.values(portImages)

const StarfieldFallback = () => (
  <div className="absolute h-full inset-0 overflow-hidden bg-black z-(--z-starfield)">
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

  const handleSceneChangeEnd = useCallback(() => {
    useGameStore.getState().setLookAtTarget(undefined)
  }, [])

  const handleTargetRest = useCallback((target: PositionedGameObject) => {
    useGameStore.getState().setPlayerTargetId(target.id)
    useGameStore.getState().setLookAtTarget(target.id)
  }, [])

  // Stable callback reference - setStarfieldReady is from zustand so it's stable
  const handleCreated = useCallback(() => {
    console.debug("%c[STARFIELD] Starfield created", "color: blue; font-weight: bold")
    setStarfieldReady(true)
  }, [setStarfieldReady])

  const handleSceneChangeStart = useCallback((isInitial = false) => {
    if (isInitial) {
      useAudioStore.getState().playSound("enter", { volume: 0.2 })
    } else {
      useAudioStore.getState().playSound("warp", { volume: 0.2 })
    }
  }, [])

  const starfieldConfig = useMemo(() => {
    return {
      imageAssets: [
        ...skyboxImageList.map((url) => ({ type: "skybox" as const, url })),
        ...portImageList.map((url) => ({ type: "port" as const, url })),
      ],
    }
  }, [])

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
        className={cn(
          "absolute inset-0 z-(--z-starfield) overflow-hidden bg-black",
          lookMode ? "cursor-look-mode" : ""
        )}
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
          onSceneChangeStart={handleSceneChangeStart}
          onTargetRest={handleTargetRest}
        />
      </motion.div>

      <StarfieldPlayerCard />
    </Suspense>
  )
}
