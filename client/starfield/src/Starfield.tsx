import { memo, Suspense, useLayoutEffect, useRef } from "react"
import { PerformanceMonitor, Stats } from "@react-three/drei"
import { Canvas } from "@react-three/fiber"
import deepEqual from "fast-deep-equal"
import { Leva } from "leva"
import * as THREE from "three"

import { RenderingIndicator } from "@/components/RenderingIndicator"
import { AnimationController } from "@/controllers/AnimationController"
import { CameraController } from "@/controllers/Camera"
import { EffectChainingController } from "@/controllers/EffectChainingController"
import { PostProcessing } from "@/controllers/PostProcessing"
import { SceneController } from "@/controllers/SceneController"
import { useDevControls } from "@/hooks/useDevControls"
import { usePerformanceProfile } from "@/hooks/usePerformanceProfile"
import { Dust } from "@/objects/Dust"
import { Fog } from "@/objects/Fog"
import { Nebula } from "@/objects/Nebula"
import { Planet } from "@/objects/Planet"
import { Stars } from "@/objects/Stars"
import { Sun } from "@/objects/Sun"
import { Tunnel } from "@/objects/Tunnel"
import { VolumetricClouds } from "@/objects/VolumetricClouds"
import type { PerformanceProfile, Scene, StarfieldConfig } from "@/types"
import { LAYERS } from "@/types"
import { useCallbackStore } from "@/useCallbackStore"
import { useGameStore } from "@/useGameStore"

interface StarfieldBaseProps {
  config?: Partial<StarfieldConfig>
  profile?: PerformanceProfile
  debug?: boolean
  scene?: Scene
  paused?: boolean
}

export function StarfieldComponent({
  config,
  debug = true,
  profile,
}: StarfieldBaseProps) {
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const isPaused = useGameStore((state) => state.isPaused)
  const setStarfieldConfig = useGameStore((state) => state.setStarfieldConfig)
  const callbacks = useCallbackStore((state) => state)

  usePerformanceProfile({ initialProfile: profile })

  const { dpr, setPerformance } = useDevControls({ profile })

  /* Handle config changes */
  const prevConfigRef = useRef<Partial<StarfieldConfig> | undefined>(undefined)
  useLayoutEffect(() => {
    if (!config) return

    // Only update if actually different
    if (!deepEqual(prevConfigRef.current, config)) {
      console.debug("[STARFIELD] Updating Starfield Config:", config)
      setStarfieldConfig(config)
      prevConfigRef.current = config
    }
  }, [config, setStarfieldConfig])

  return (
    <>
      <Leva collapsed hidden={!debug} />

      <Canvas
        frameloop={isPaused ? "never" : "demand"}
        dpr={dpr as number}
        gl={{
          alpha: false,
          antialias: false,
        }}
        onCreated={({ gl, camera }) => {
          rendererRef.current = gl
          gl.setClearColor(new THREE.Color("#000000"))

          // Enable various layers
          camera.layers.enable(LAYERS.DEFAULT)
          camera.layers.enable(LAYERS.BACKGROUND)
          camera.layers.enable(LAYERS.SKYBOX)
          camera.layers.enable(LAYERS.FOREGROUND)
          camera.layers.enable(LAYERS.GAMEOBJECTS)
          if (debug) {
            camera.layers.enable(LAYERS.DEBUG)
          }
          callbacks.onCreated?.()
        }}
      >
        <PerformanceMonitor
          onIncline={() => {
            setPerformance({ dpr: 2 })
            console.log("[STARFIELD] Performance Profile: high")
          }}
          onDecline={() => {
            setPerformance({ dpr: 1 })
            console.log("[STARFIELD] Performance Profile: low")
          }}
        />

        {debug && (
          <>
            <Stats showPanel={0} />
            <RenderingIndicator />
          </>
        )}
        <AnimationController>
          <Suspense fallback={null}>
            <Fog />
            <Nebula />
            <Tunnel />
            <Sun />
            <Stars />
            <Dust />
            <VolumetricClouds />
            <Planet />

            {/* DEBUG: Grid to visualize layers */}
            {/*debug && (
              <Grid
                cellColor={"#FFFFFF"}
                cellSize={1}
                infiniteGrid
                layers={[LAYERS.DEBUG]}
              />
            )*/}
          </Suspense>

          <CameraController />
          <EffectChainingController />
          <PostProcessingMemo />
        </AnimationController>

        {/*
          <CameraController />
        <EffectChainingController />
          <SceneController />
          <PostProcessingMemo />*/}
        <SceneController />
      </Canvas>
    </>
  )
}

export const PostProcessingMemo = memo(PostProcessing)

export interface StarfieldProps extends StarfieldBaseProps {
  onStart?: () => void
  onStop?: () => void
  onCreated?: () => void
  onUnsupported?: () => void
  // ETC
}

export const Starfield = memo(
  ({ onStart, onStop, onCreated, onUnsupported, ...props }: StarfieldProps) => {
    useCallbackStore.setState({
      onCreated: onCreated ?? (() => {}),
      onStart: onStart ?? (() => {}),
      onStop: onStop ?? (() => {}),
      onUnsupported: onUnsupported ?? (() => {}),
    })
    return <StarfieldComponent {...props} />
  }
)
