import { Suspense, useLayoutEffect, useRef } from "react"
import { PerformanceMonitor, Stats } from "@react-three/drei"
import { Canvas, useFrame } from "@react-three/fiber"
import deepEqual from "fast-deep-equal"
import { Leva } from "leva"
import * as THREE from "three"

import { AssetPreloader } from "@/components/AssetPreloader"
import { RenderingIndicator } from "@/components/RenderingIndicator"
import { LAYERS } from "@/constants"
import { AnimationController } from "@/controllers/AnimationController"
import { CameraController } from "@/controllers/CameraController"
import { GameObjectsController } from "@/controllers/GameObjectsController"
import { PostProcessingController } from "@/controllers/PostProcessingController"
import { useDevControls } from "@/hooks/useDevControls"
import { usePerformanceProfile } from "@/hooks/usePerformanceProfile"
import {
  Dust,
  Fog,
  GameObjects,
  Nebula,
  Planet,
  Stars,
  Sun,
  Tunnel,
  VolumetricClouds,
} from "@/objects"
import type {
  GameObject,
  PerformanceProfile,
  PositionedGameObject,
  StarfieldConfig,
} from "@/types"
import { useAnimationStore } from "@/useAnimationStore"
import { useCallbackStore } from "@/useCallbackStore"
import { useGameStore } from "@/useGameStore"

/**
 * SuspenseReady - Signals when Suspense content has mounted (once only)
 *
 * Placed at the end of Suspense to ensure all scene objects are mounted.
 * Waits 2 frames for shaders to compile, then signals suspenseReady.
 * Only fires once - subsequent Suspense re-renders (from new asset loads) are ignored.
 */
function SuspenseReady() {
  const frameCount = useRef(0)

  useFrame(() => {
    // Check store state directly - persists across Suspense re-renders
    if (useAnimationStore.getState().suspenseReady) return

    frameCount.current++
    if (frameCount.current >= 2) {
      useAnimationStore.getState().setSuspenseReady(true)
    }
  })

  return null
}

interface StarfieldBaseProps {
  lookMode?: boolean
  config?: Partial<StarfieldConfig>
  profile?: PerformanceProfile
  debug?: boolean
  className?: string
  gameObjects?: GameObject[]
}

export interface StarfieldProps extends StarfieldBaseProps {
  onStart?: () => void
  onStop?: () => void
  onCreated?: () => void
  onReady?: () => void
  onUnsupported?: () => void
  onWarpAnimationStart?: () => void
  onTargetRest?: (target: PositionedGameObject) => void
  onTargetClear?: () => void
  generateInitialScene?: boolean
}

export function StarfieldComponent({
  config,
  debug = false,
  lookMode = true,
  profile,
  className,
  gameObjects,
}: StarfieldBaseProps) {
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const isPaused = useGameStore((state) => state.isPaused)
  const setStarfieldConfig = useGameStore((state) => state.setStarfieldConfig)
  const setGameObjects = useGameStore((state) => state.setGameObjects)
  const callbacks = useCallbackStore((state) => state)

  usePerformanceProfile({ initialProfile: profile })

  const { dpr } = useDevControls({ profile })

  /* Handle config changes */
  const prevConfigRef = useRef<Partial<StarfieldConfig> | undefined>(undefined)
  useLayoutEffect(() => {
    if (!config) return

    // Only update if actually different
    if (!deepEqual(prevConfigRef.current, config)) {
      console.debug("[STARFIELD] Updating Starfield Config:", config)
      // Note: we flag for deepmerge here to retain default values
      setStarfieldConfig(config, true)
      prevConfigRef.current = config
    }
  }, [config, setStarfieldConfig])

  /* Handle gameObjects prop changes */
  const prevGameObjectsRef = useRef<GameObject[] | undefined>(undefined)
  useLayoutEffect(() => {
    if (!gameObjects) return

    // Only update if actually different
    if (!deepEqual(prevGameObjectsRef.current, gameObjects)) {
      console.debug("[STARFIELD] Updating Game Objects:", gameObjects)
      setGameObjects(gameObjects)
      prevGameObjectsRef.current = gameObjects
    }
  }, [gameObjects, setGameObjects])

  return (
    <>
      <Leva hidden={!debug} titleBar={{ title: "Starfield" }} />

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
          camera.layers.enable(LAYERS.OVERLAY)
          if (debug) {
            camera.layers.enable(LAYERS.DEBUG)
          }

          callbacks.onCreated?.()
        }}
        className={className}
      >
        <PerformanceMonitor
          onIncline={() => {
            //setPerformance({ dpr: 2 })
            //console.log("[STARFIELD] Performance Profile: high")
          }}
          onDecline={() => {
            //setPerformance({ dpr: 1 })
            //console.log("[STARFIELD] Performance Profile: low")
          }}
        />

        {debug && (
          <>
            <Stats showPanel={0} />
            <RenderingIndicator />
          </>
        )}
        <Suspense fallback={null}>
          <AssetPreloader />
          <Fog />
          <Nebula />
          <Sun />
          <Stars />
          <Dust />
          <VolumetricClouds />
          <Planet />
          <Tunnel />
          <SuspenseReady />
        </Suspense>

        <CameraController enabled={lookMode} debug={debug} />
        <GameObjectsController />
        <GameObjects />
        <PostProcessingController />
        <AnimationController />
      </Canvas>
    </>
  )
}

export const Starfield = ({
  onStart,
  onStop,
  onCreated,
  onReady,
  onUnsupported,
  onWarpAnimationStart,
  onTargetRest,
  onTargetClear,
  ...props
}: StarfieldProps) => {
  const callbacksRef = useRef({
    onStart,
    onStop,
    onCreated,
    onReady,
    onUnsupported,
    onWarpAnimationStart,
    onTargetRest,
    onTargetClear,
  })

  useLayoutEffect(() => {
    callbacksRef.current = {
      onStart,
      onStop,
      onCreated,
      onReady,
      onUnsupported,
      onWarpAnimationStart,
      onTargetRest,
      onTargetClear,
    }
  })

  // Only set up callbacks once
  useLayoutEffect(() => {
    const getCallbacks = () => callbacksRef.current

    useCallbackStore.setState({
      onCreated: () => getCallbacks().onCreated?.(),
      onReady: () => getCallbacks().onReady?.(),
      onStart: () => getCallbacks().onStart?.(),
      onStop: () => getCallbacks().onStop?.(),
      onUnsupported: () => getCallbacks().onUnsupported?.(),
      onWarpAnimationStart: () => getCallbacks().onWarpAnimationStart?.(),
      onTargetRest: (target) => getCallbacks().onTargetRest?.(target),
      onTargetClear: () => getCallbacks().onTargetClear?.(),
    })
  }, [])

  return <StarfieldComponent {...props} />
}
