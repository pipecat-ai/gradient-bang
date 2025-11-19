import { memo, Suspense, useLayoutEffect, useRef } from "react"
import {
  Center,
  Float,
  Grid,
  PerformanceMonitor,
  Stats,
} from "@react-three/drei"
import { Canvas } from "@react-three/fiber"
import deepEqual from "fast-deep-equal"
import { Leva } from "leva"
import * as THREE from "three"

import { AnimationController } from "@/controllers/AnimationController"
import { CameraController } from "@/controllers/Camera"
import { SceneController } from "@/controllers/SceneController"
import { Dust } from "@/objects/Dust"
import { Nebula } from "@/objects/Nebula"
import { Stars } from "@/objects/Stars"
import { Sun } from "@/objects/Sun"
import type { PerformanceProfile, Scene, StarfieldConfig } from "@/types"
import { useGameStore } from "@/useGameStore"

import { RenderingIndicator } from "./components/RenderingIndicator"
import { EffectChainingController } from "./controllers/EffectChainingController"
import { PostProcessing } from "./controllers/PostProcessing"
import { useDevControls } from "./hooks/useDevControls"
import { usePerformanceProfile } from "./hooks/usePerformanceProfile"
import { Fog } from "./objects/Fog"
import { Planet } from "./objects/Planet"
import { useCallbackStore } from "./useCallbackStore"

interface StarfieldBaseProps {
  config?: Partial<StarfieldConfig>
  profile?: PerformanceProfile
  debug?: boolean
  scene?: Scene
  paused?: boolean
}

export const LAYERS = {
  DEFAULT: 0, // Main scene objects
  BACKGROUND: 1, // Stars
  SKYBOX: 2, // Skybox (Planet, Shadow)
  FOREGROUND: 3, // Sun, Volumentrics
  GAMEOBJECTS: 4, // GameObjects
  DEBUG: 31, // Grid, debug helpers
} as const

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

  const { dpr, setPerformance } = useDevControls()

  /* Handle config changes */
  const prevConfigRef = useRef<Partial<StarfieldConfig> | undefined>(undefined)
  useLayoutEffect(() => {
    if (!config) return

    // Only update if actually different
    if (!deepEqual(prevConfigRef.current, config)) {
      console.log("[STARFIELD] Updating Starfield Config:", config)
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
          onIncline={() => setPerformance({ dpr: 2 })}
          onDecline={() => setPerformance({ dpr: 1 })}
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
            <Stars />
            <Sun />
            <Planet />
            <Dust />
            <Nebula />

            {/* Nebula background - rendered first and positioned at the back */}
            <group position={[0, 0, -50]}>
              {/* <Nebula ref={nebulaRef} /> */}
            </group>

            <group position={[0, 0, 0]}>
              <Float
                enabled={false}
                floatIntensity={1}
                rotationIntensity={0.5}
                speed={3}
                autoInvalidate={false}
              >
                {/* Scene Elements */}
                <Center scale={3}>{/* ELEMENTS GO HERE */}</Center>
              </Float>
            </group>
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
          <SceneController />

          <PostProcessingMemo />
        </AnimationController>
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
