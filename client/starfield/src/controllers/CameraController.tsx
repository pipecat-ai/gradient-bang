import { useEffect, useRef } from "react"
import { CameraControls as CameraControlsImpl } from "@react-three/drei"
import { useFrame, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import type { Schema } from "leva/dist/declarations/src/types"
import * as THREE from "three"

import { useProfiledFrame } from "@/hooks/useProfiledFrame"
import { useShowControls } from "@/hooks/useStarfieldControls"
import { useCallbackStore } from "@/useCallbackStore"
import { useGameStore } from "@/useGameStore"
import { useUniformStore } from "@/useUniformStore"

import { CameraShakeController } from "./CameraShakeController"

const POST_PROCESSING_ENABLED = true
const TRANSITION_DELAY_FRAMES = 2

// Default camera control values
const DEFAULT_CAMERA_CONFIG = {
  enabled: true,
  lookAtDistance: 8,
  smoothTime: 0.5,
  restThreshold: 1,
}

export function CameraController({
  enabled,
  debug = false,
}: {
  enabled: boolean
  debug?: boolean
}) {
  const showControls = useShowControls()
  const cameraControlsRef = useRef<CameraControlsImpl>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const prevLookAtTargetRef = useRef<string | null>(null)
  const prevIsSceneChangingRef = useRef(false)
  const transitionDelayFramesRef = useRef(0)
  const pendingTargetRef = useRef<string | null>(null)
  const { cameraBaseFov } = useGameStore((state) => state.starfieldConfig)

  const isSceneChanging = useGameStore((state) => state.isSceneChanging)
  const lookAtTarget = useGameStore((state) => state.lookAtTarget)
  const isCameraTransitioning = useGameStore(
    (state) => state.isCameraTransitioning
  )
  const setIsCameraTransitioning = useGameStore(
    (state) => state.setIsCameraTransitioning
  )

  const { invalidate, camera } = useThree()

  // Store camera ref
  useEffect(() => {
    const perspectiveCamera = camera as THREE.PerspectiveCamera
    if (perspectiveCamera.isPerspectiveCamera) {
      cameraRef.current = perspectiveCamera
    }
  }, [camera])

  // Register camera FOV as an animatable uniform
  useEffect(() => {
    const perspectiveCamera = cameraRef.current
    if (!perspectiveCamera) return

    // Create a pseudo-uniform initialized with the config's base FOV
    const fovUniform = { value: cameraBaseFov ?? perspectiveCamera.fov }

    useUniformStore.getState().registerUniform("cameraFov", fovUniform, {
      initial: cameraBaseFov,
    })

    return () => {
      useUniformStore.getState().removeUniform("cameraFov")
    }
  }, [camera, cameraBaseFov])

  // Sync the pseudo-uniform value to the actual camera FOV each frame
  useFrame(() => {
    const fovUniform = useUniformStore
      .getState()
      .getUniform<number>("cameraFov")
    const perspectiveCamera = cameraRef.current
    if (fovUniform && perspectiveCamera) {
      if (perspectiveCamera.fov !== fovUniform.uniform.value) {
        perspectiveCamera.fov = fovUniform.uniform.value
        perspectiveCamera.updateProjectionMatrix()
      }
    }
  })

  // Trigger initial invalidation when lookAtTarget changes to kick off the render loop
  useEffect(() => {
    if (lookAtTarget !== prevLookAtTargetRef.current) {
      invalidate()
    }
  }, [lookAtTarget, invalidate])

  const [levaConfig] = useControls(
    () =>
      (showControls
        ? {
            "Scene Settings": folder({
              Camera: folder(
                {
                  enabled: {
                    value: DEFAULT_CAMERA_CONFIG.enabled,
                    label: "Enable Camera Controls",
                  },
                  fov: {
                    value: cameraBaseFov!,
                    min: 20,
                    max: 150,
                    step: 1,
                    label: "FOV",
                    onChange: (value: number) => {
                      useUniformStore.getState().setUniform("cameraFov", value)
                      invalidate()
                    },
                  },
                  lookAtDistance: {
                    value: DEFAULT_CAMERA_CONFIG.lookAtDistance,
                    min: 2,
                    max: 20,
                    step: 0.5,
                    label: "Look At Distance",
                  },
                  smoothTime: {
                    value: DEFAULT_CAMERA_CONFIG.smoothTime,
                    min: 0.1,
                    max: 5,
                    step: 0.1,
                    label: "Smooth Time",
                  },
                  restThreshold: {
                    value: DEFAULT_CAMERA_CONFIG.restThreshold,
                    min: 0.001,
                    max: 5,
                    step: 0.01,
                    label: "Rest Threshold",
                  },
                },
                { collapsed: true }
              ),
            }),
          }
        : {}) as Schema
  )

  // Use Leva values when controls shown, prop/defaults otherwise
  const config = showControls
    ? (levaConfig as typeof DEFAULT_CAMERA_CONFIG)
    : { ...DEFAULT_CAMERA_CONFIG, enabled }

  // Sync Leva config to CameraControls instance
  useEffect(() => {
    if (cameraControlsRef.current) {
      cameraControlsRef.current.smoothTime = config.smoothTime
      cameraControlsRef.current.restThreshold = config.restThreshold
    }
  }, [config.smoothTime, config.restThreshold])

  useProfiledFrame("Camera", ({ camera, gl, scene }) => {
    const cam = cameraControlsRef.current

    // Handle lookAtTarget changes
    const lookAtTarget = useGameStore.getState().lookAtTarget
    const positionedGameObjects = useGameStore.getState().positionedGameObjects
    const prevTarget = prevLookAtTargetRef.current

    if (cam) {
      // Reset camera to center when scene change exits (new scene applied)
      const isSceneChanging = useGameStore.getState().isSceneChanging
      if (prevIsSceneChangingRef.current && !isSceneChanging) {
        cam.setLookAt(0, 0, config.lookAtDistance, 0, 0, 0, false)
        prevLookAtTargetRef.current = null
        pendingTargetRef.current = null
        transitionDelayFramesRef.current = 0
      }
      prevIsSceneChangingRef.current = isSceneChanging

      // Reset camera when target is cleared (was something, now null)
      if (lookAtTarget === undefined && prevTarget !== null) {
        setIsCameraTransitioning(true)
        cam.setLookAt(0, 0, config.lookAtDistance, 0, 0, 0, true)
        prevLookAtTargetRef.current = null
        pendingTargetRef.current = null
        transitionDelayFramesRef.current = 0
        // Trigger onTargetClear callback
        useCallbackStore.getState().onTargetClear()
      }

      // Detect new target - start delay countdown
      if (
        lookAtTarget &&
        lookAtTarget !== prevTarget &&
        lookAtTarget !== pendingTargetRef.current
      ) {
        pendingTargetRef.current = lookAtTarget
        transitionDelayFramesRef.current = TRANSITION_DELAY_FRAMES
        invalidate() // Ensure we keep rendering during delay
      }

      // Count down delay frames and execute transition when ready
      if (pendingTargetRef.current && transitionDelayFramesRef.current > 0) {
        transitionDelayFramesRef.current--
        invalidate() // Keep rendering during delay
      } else if (
        pendingTargetRef.current &&
        transitionDelayFramesRef.current === 0
      ) {
        // Delay complete - start the actual camera movement
        const gameObject = positionedGameObjects.find(
          (obj) => obj.id === pendingTargetRef.current
        )
        if (gameObject) {
          const targetPosition = new THREE.Vector3(...gameObject.position)

          // Get the current camera position from CameraControls (accounts for user interaction)
          const currentCameraPosition = new THREE.Vector3()
          cam.getPosition(currentCameraPosition)

          const direction = new THREE.Vector3()
            .subVectors(currentCameraPosition, targetPosition)
            .normalize()

          const newCameraPosition = targetPosition
            .clone()
            .add(direction.multiplyScalar(config.lookAtDistance))

          cam.setLookAt(
            newCameraPosition.x,
            newCameraPosition.y,
            newCameraPosition.z,
            gameObject.position[0],
            gameObject.position[1],
            gameObject.position[2],
            true
          )
          prevLookAtTargetRef.current = pendingTargetRef.current
        }
        pendingTargetRef.current = null
      }
    }

    // Keep invalidating during camera transitions
    if (useGameStore.getState().isCameraTransitioning) {
      invalidate()
    }

    if (!POST_PROCESSING_ENABLED) {
      gl.render(scene, camera)
    }
  }, 1)

  return (
    <>
      <CameraControlsImpl
        makeDefault
        ref={cameraControlsRef}
        enabled={config.enabled && !isSceneChanging && !isCameraTransitioning}
        smoothTime={config.smoothTime}
        restThreshold={config.restThreshold}
        dollySpeed={0.5}
        truckSpeed={0.5}
        //regress={true} @NOTE: lowers quality on camera movement, toggle on with lower performance profile
        polarRotateSpeed={1}
        azimuthRotateSpeed={1}
        // Disable scroll wheel zooming
        // ACTION values: ROTATE=1, TRUCK=2, DOLLY=8, NONE=0
        mouseButtons={
          debug ? { left: 1, middle: 8, right: 2, wheel: 16 } : undefined
        }
        onTransitionStart={() => {
          // Only set transitioning when we have a look-at target (not for user interactions)
          if (useGameStore.getState().lookAtTarget) {
            setIsCameraTransitioning(true)
          }
          invalidate()
        }}
        onRest={() => {
          setIsCameraTransitioning(false)
          // Trigger onTargetRest callback if we have a target
          const targetId = useGameStore.getState().lookAtTarget
          if (targetId) {
            const target = useGameStore
              .getState()
              .positionedGameObjects.find((obj) => obj.id === targetId)
            if (target) {
              useCallbackStore.getState().onTargetRest(target)
            }
          }
        }}
      />
      <CameraShakeController cameraControlsRef={cameraControlsRef} />
    </>
  )
}
